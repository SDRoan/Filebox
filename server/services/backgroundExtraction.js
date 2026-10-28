const FileContent = require('../models/FileContent');
const textExtractor = require('./textExtractor');
const aiSearch = require('./aiSearch');
const { classifyAndSave } = require('./fileClassifier');

/**
 * Read a newly uploaded file's text after the upload has been answered, so File Box AI can search it,
 * describe it and answer questions from it. Used for personal and Team Space uploads alike.
 * Never throws: a file that cannot be read is simply stored without text.
 * extractNow resolves when the file has been read (for callers that read many files one at a time).
 */
async function extractNow(file) {
  try {
    if (!textExtractor.isSupported(file.mimeType)) return;
    const result = await textExtractor.extractTextWithMetadata(file.path, file.mimeType, file.originalName);
    const text = (result.text || '').trim();
    const embedding = text ? await aiSearch.generateEmbedding(text) : [];
    await FileContent.findOneAndUpdate(
      { file: file._id },
      {
        $set: {
          extractedText: text,
          embedding,
          extractionMethod: result.method || '',
          extractionStatus: text ? 'completed' : 'failed',
          extractedAt: new Date(),
        },
        $setOnInsert: { file: file._id },
      },
      { upsert: true }
    );
    console.log(`[Extraction] ${text ? `Read ${text.length} characters from` : 'No text found in'} ${file.originalName}`);
    // Rules only (no AI); the background profile may refine it later. A person's correction is kept.
    await classifyAndSave(file._id);
  } catch (error) {
    console.error(`[Extraction] Could not read ${file.originalName}:`, error.message);
  }
}

function extractInBackground(file) {
  setImmediate(() => extractNow(file));
}

module.exports = { extractInBackground, extractNow };
