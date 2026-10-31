const express = require('express');
const auth = require('../middleware/auth');
const File = require('../models/File');
const FileContent = require('../models/FileContent');
const aiSearch = require('../services/aiSearch');
const { searchWorkspace } = require('../services/workspaceSearch');
const { advancedSearch, SearchInputError } = require('../services/advancedSearch');
const { TAXONOMY, isValid, classifyAndSave, effectiveClassification, setUserClassification } = require('../services/fileClassifier');
const { authorizeFile, sendDenied } = require('../services/permissions');
const router = express.Router();

/**
 * AI-powered semantic search
 * Searches through file contents, not just filenames
 */
router.get('/ai', auth, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.trim().length === 0) {
      return res.json({ files: [], folders: [] });
    }

    const query = q.trim();
    const { files, folders, stats } = await searchWorkspace(req.user._id, query);

    res.json({
      files,
      folders,
      query,
      searchType: 'ai',
      debug: stats
    });
  } catch (error) {
    console.error('AI search error:', error);
    res.status(500).json({ message: 'Search failed', error: error.message });
  }
});

/**
 * Advanced Search: words inside files, with format, date and location filters and sorting.
 * Only stored text is searched (no file reads, OCR or AI), and only files the user can read are returned.
 */
router.get('/advanced', auth, async (req, res) => {
  try {
    const { q, category, documentType, topic, format, date, dateField, from, to, tz, location, folderId, teamId, currentFolderId, sort, limit, offset, parse, semantic } = req.query;
    // parse: 'rules' reads filters out of the words; 'model' may also ask the local model once (after Enter).
    // semantic: 'on' only when the person asked to search by meaning.
    if (parse !== undefined && !['off', 'rules', 'model'].includes(parse)) return res.status(400).json({ message: `Unknown value "${parse}"` });
    if (semantic !== undefined && !['off', 'on'].includes(semantic)) return res.status(400).json({ message: `Unknown value "${semantic}"` });
    const result = await advancedSearch(req.user._id, {
      text: q, category, documentType, topic, format, date, dateField, from, to, tz, location, folderId, teamId, currentFolderId, sort, limit, offset, parse, semantic,
    });
    // Same answer for a folder that does not exist and one the user cannot open.
    if (result.folderNotFound) return res.status(404).json({ message: 'Folder not found' });
    res.json(result);
  } catch (error) {
    if (error instanceof SearchInputError) return res.status(400).json({ message: error.message });
    console.error('Advanced search error:', error);
    res.status(500).json({ message: 'Search failed' });
  }
});

/** The categories and document types Advanced Search and category corrections use. */
router.get('/taxonomy', auth, (req, res) => {
  res.json({ categories: Object.entries(TAXONOMY).map(([name, documentTypes]) => ({ name, documentTypes })) });
});

/**
 * Correct a file's category: { primaryCategory, documentType }, or { reset: true } to go back to the
 * automatic one. Owners and editors only; someone who cannot see the file gets the same 404 as a missing one.
 */
router.patch('/classification/:fileId', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { primaryCategory, documentType, reset } = req.body || {};
    if (reset !== true && !isValid(primaryCategory, documentType)) {
      return res.status(400).json({ message: 'Choose a category and one of its document types' });
    }
    const classification = await setUserClassification(access.file, req.user._id, reset === true ? null : { primaryCategory, documentType });
    res.json({ fileId: access.file._id, classification });
  } catch (error) {
    console.error('Classification update error:', error);
    res.status(500).json({ message: 'Could not update the category' });
  }
});

/**
 * Work out a file's automatic category again: rules now, then (when File Box AI is running) a fresh
 * profile of this one file in the background. A person's correction is kept and still wins.
 */
router.post('/classification/:fileId/reclassify', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const file = access.file;
    await classifyAndSave(file._id);
    const content = await FileContent.findOne({ file: file._id });
    let profile = 'no_text';
    if (content?.extractedText?.trim()) {
      const health = await require('../services/ollamaClient').health();
      profile = health.reachable && health.assistantModelAvailable ? 'queued' : 'unavailable';
      if (profile === 'queued') {
        const profiler = require('../services/fileProfiler');
        setImmediate(async () => {
          try {
            // No usable answer: marked as read, as the background profiler does, so it is not picked again.
            if (!(await profiler.profileFile(file, content))) {
              console.log(`[Classify] Reclassify: no new profile for ${file.originalName}`);
              await FileContent.updateOne({ _id: content._id }, { $set: { aiProfiledAt: new Date(), aiProfileVersion: profiler.PROFILE_VERSION, topics: content.topics || [] } });
            }
          } catch (error) {
            console.error('[Classify] Reclassify profile failed:', error.message);
          }
        });
      }
    }
    res.json({ fileId: file._id, classification: effectiveClassification(file, content?.toObject() || null), profile });
  } catch (error) {
    console.error('Reclassify error:', error);
    res.status(500).json({ message: 'Could not reclassify the file' });
  }
});

/**
 * Extract text from all user's files (useful for existing files)
 */
router.post('/extract-all', auth, async (req, res) => {
  try {
    const { force } = req.body; // Allow force re-extraction
    console.log('[Extract-All] User ID:', req.user._id, force ? '(FORCE MODE)' : '');
    
    const files = await File.find({
      owner: req.user._id,
      isTrashed: { $ne: true }
    });
    
    console.log('[Extract-All] Found', files.length, 'files');
    files.forEach(f => {
      console.log(`  - ${f.originalName} (${f.mimeType})`);
    });

    const textExtractor = require('../services/textExtractor');
    const FileContent = require('../models/FileContent');
    const aiSearch = require('../services/aiSearch');

    let extracted = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails = [];
    const skipReasons = [];

    for (const file of files) {
      try {
        console.log(`[Extract-All] Processing: ${file.originalName} (${file.mimeType})`);
        
        // Check if already extracted (but allow re-extraction if text is empty or force mode)
        const existing = await FileContent.findOne({ file: file._id });
        if (!force && existing && existing.extractionStatus === 'completed' && existing.extractedText && existing.extractedText.length > 0) {
          console.log(`[Extract-All] ⏭️ Skipping ${file.originalName} - already extracted`);
          skipReasons.push({ filename: file.originalName, reason: 'Already extracted' });
          skipped++;
          continue;
        }
        
        // Clear the old text in force mode or if it has none. The record itself stays, so a person's
        // category correction (userClassification) survives re-reading the file.
        if (existing && (force || !existing.extractedText || existing.extractedText.length === 0)) {
          console.log(`[Extract-All] 🗑️ Clearing existing text for ${file.originalName} (force: ${force})`);
          existing.extractedText = '';
          existing.embedding = [];
          existing.extractionStatus = 'pending';
          existing.extractedAt = new Date();
          await existing.save();
        }

        if (!textExtractor.isSupported(file.mimeType)) {
          console.log(`[Extract-All] ⏭️ Skipping ${file.originalName} - unsupported type: ${file.mimeType}`);
          skipReasons.push({ filename: file.originalName, reason: `Unsupported type: ${file.mimeType}` });
          skipped++;
          continue;
        }

        // Check if file exists
        const fs = require('fs-extra');
        const fileExists = await fs.pathExists(file.path);
        if (!fileExists) {
          console.log(`[Extract-All] ❌ File not found at path: ${file.path}`);
          errors++;
          continue;
        }

        console.log(`[Extract-All] 🔄 Extracting text from: ${file.originalName}`);
        let extractedText;
        try {
          extractedText = await textExtractor.extractText(file.path, file.mimeType);
          console.log(`[Extract-All] 📝 Extracted ${extractedText ? extractedText.length : 0} characters from: ${file.originalName}`);
        } catch (extractError) {
          console.error(`[Extract-All] ❌ Extraction error for ${file.originalName}:`, extractError.message);
          errors++;
          errorDetails.push({
            filename: file.originalName,
            error: `Extraction failed: ${extractError.message}`,
            type: 'extraction_error'
          });
          continue;
        }
        
        if (extractedText && extractedText.length > 0) {
          console.log(`[Extract-All] ֎ Generating embedding for: ${file.originalName}`);
          const embedding = await aiSearch.generateEmbedding(extractedText);
          console.log(`[Extract-All] ✅ Generated embedding (${embedding.length} dimensions) for: ${file.originalName}`);
          
          if (existing) {
            existing.extractedText = extractedText;
            existing.embedding = embedding;
            existing.extractionStatus = 'completed';
            await existing.save();
          } else {
            const fileContent = new FileContent({
              file: file._id,
              extractedText,
              embedding,
              extractionStatus: 'completed'
            });
            await fileContent.save();
          }
          await classifyAndSave(file._id);
          extracted++;
          console.log(`[Extract-All] ✅ Successfully processed: ${file.originalName}`);
        } else {
          // Determine reason for no text
          let reason = 'No text found';
          if (file.mimeType.includes('pdf')) {
            reason = 'No text found - PDF may be scanned/image-based (OCR attempted but found no text)';
          } else {
            reason = 'No text found (file may be empty or unsupported format)';
          }
          
          console.log(`[Extract-All] ⚠️ No text extracted from: ${file.originalName}`);
          skipReasons.push({ filename: file.originalName, reason });
          // Still create a record so we know we tried
          if (!existing) {
            const fileContent = new FileContent({
              file: file._id,
              extractedText: '',
              embedding: [],
              extractionStatus: 'failed'
            });
            await fileContent.save();
          }
          skipped++;
        }
      } catch (error) {
        console.error(`[Extract-All] ❌ Error extracting ${file.originalName}:`, error.message);
        console.error(error.stack);
        errors++;
        errorDetails.push({
          filename: file.originalName,
          error: error.message,
          stack: error.stack
        });
      }
    }

    res.json({
      message: 'Extraction completed',
      extracted,
      skipped,
      errors,
      total: files.length,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      skipReasons: skipReasons.length > 0 ? skipReasons : undefined,
      details: {
        filesProcessed: files.map(f => ({
          name: f.originalName,
          type: f.mimeType,
          path: f.path
        }))
      }
    });
  } catch (error) {
    console.error('Bulk extraction error:', error);
    res.status(500).json({ message: 'Extraction failed', error: error.message });
  }
});

/**
 * Test PDF extraction on a specific file (for debugging)
 */
router.get('/test-extract/:fileId', auth, async (req, res) => {
  try {
    const file = await File.findOne({
      _id: req.params.fileId,
      owner: req.user._id
    });

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    if (!file.mimeType.includes('pdf')) {
      return res.json({ message: 'File is not a PDF', mimeType: file.mimeType });
    }

    const textExtractor = require('../services/textExtractor');
    const fs = require('fs-extra');
    
    // Check if file exists
    const fileExists = await fs.pathExists(file.path);
    if (!fileExists) {
      return res.status(404).json({ message: 'File not found on disk', path: file.path });
    }

    // Extract text with detailed logging
    console.log(`[Test Extract] Testing extraction for: ${file.originalName}`);
    const extractedText = await textExtractor.extractText(file.path, file.mimeType);

    res.json({
      filename: file.originalName,
      path: file.path,
      fileSize: file.size,
      mimeType: file.mimeType,
      extractedTextLength: extractedText.length,
      extractedTextPreview: extractedText.substring(0, 500),
      fullText: extractedText.length < 10000 ? extractedText : extractedText.substring(0, 10000) + '... (truncated)',
      success: extractedText.length > 0
    });
  } catch (error) {
    console.error('Test extraction error:', error);
    res.status(500).json({ message: 'Extraction failed', error: error.message, stack: error.stack });
  }
});

/**
 * Extract text from a file (triggered manually or on upload)
 */
router.post('/extract/:fileId', auth, async (req, res) => {
  try {
    const file = await File.findOne({
      _id: req.params.fileId,
      owner: req.user._id
    });

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    const textExtractor = require('../services/textExtractor');
    const path = require('path');
    const filePath = file.path;

    // Check if extraction is supported
    if (!textExtractor.isSupported(file.mimeType)) {
      return res.json({ 
        message: 'File type not supported for text extraction',
        supported: false
      });
    }

    // Extract text
    console.log(`[Extract] Extracting text from: ${file.originalName} (${file.mimeType})`);
    console.log(`[Extract] File path: ${filePath}`);
    
    const extractedText = await textExtractor.extractText(filePath, file.mimeType);
    console.log(`[Extract] Extracted ${extractedText.length} characters`);

    if (!extractedText || extractedText.length === 0) {
      return res.status(400).json({ 
        message: 'No text could be extracted from this file',
        textLength: 0,
        suggestion: 'The file may be image-based, empty, or in an unsupported format. Check server logs for details.'
      });
    }

    // Generate embedding
    const embedding = await aiSearch.generateEmbedding(extractedText);
    console.log(`[Extract] Generated embedding (${embedding.length} dimensions)`);

    // Save or update FileContent
    let fileContent = await FileContent.findOne({ file: file._id });
    if (fileContent) {
      fileContent.extractedText = extractedText;
      fileContent.embedding = embedding;
      fileContent.extractionStatus = 'completed';
      await fileContent.save();
    } else {
      fileContent = new FileContent({
        file: file._id,
        extractedText,
        embedding,
        extractionStatus: 'completed'
      });
      await fileContent.save();
    }

    res.json({
      message: 'Text extracted successfully',
      textLength: extractedText.length,
      hasEmbedding: embedding.length > 0,
      preview: extractedText.substring(0, 200)
    });
  } catch (error) {
    console.error('Extraction error:', error);
    res.status(500).json({ message: 'Extraction failed', error: error.message });
  }
});

module.exports = router;

