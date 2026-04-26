const fs = require('fs-extra');
const File = require('../models/File');
const FileContent = require('../models/FileContent');
const aiSearch = require('./aiSearch');
const textExtractor = require('./textExtractor');

class DocumentProcessingService {
  isDocumentCandidate(file) {
    if (!file) {
      return false;
    }

    const mimeType = (file.mimeType || '').toLowerCase();
    const fileName = (file.originalName || '').toLowerCase();

    return (
      mimeType.includes('pdf') ||
      mimeType.includes('word') ||
      mimeType.includes('document') ||
      mimeType.includes('msword') ||
      mimeType.includes('vnd.openxmlformats-officedocument.wordprocessingml') ||
      fileName.endsWith('.pdf') ||
      fileName.endsWith('.docx') ||
      fileName.endsWith('.doc')
    );
  }

  async getFile(fileOrId) {
    if (!fileOrId) {
      return null;
    }

    if (typeof fileOrId === 'string') {
      return File.findById(fileOrId);
    }

    return fileOrId;
  }

  async getOrCreateFileContent(fileId) {
    let fileContent = await FileContent.findOne({ file: fileId });

    if (!fileContent) {
      fileContent = new FileContent({
        file: fileId,
        extractionStatus: 'pending',
        summaryStatus: 'not_started',
      });
    }

    return fileContent;
  }

  clearSummaryState(fileContent) {
    fileContent.summary = '';
    fileContent.summaryStatus = 'not_started';
    fileContent.summaryError = '';
    fileContent.summaryProvider = '';
    fileContent.summaryGeneratedAt = null;
    fileContent.summaryModel = '';
  }

  async markQueued(fileId) {
    const fileContent = await this.getOrCreateFileContent(fileId);
    fileContent.extractionStatus = 'pending';
    this.clearSummaryState(fileContent);
    await fileContent.save();
    return fileContent;
  }

  async queueFileProcessing(fileOrId, { force = false } = {}) {
    const file = await this.getFile(fileOrId);
    if (!file || !this.isDocumentCandidate(file)) {
      return null;
    }

    await this.markQueued(file._id);

    setImmediate(async () => {
      try {
        await this.ensureExtraction(file, { force });
      } catch (error) {
        console.error(`[DocumentProcessing] Background processing failed for ${file.originalName}:`, error);
      }
    });

    return true;
  }

  async ensureExtraction(fileOrId, { force = false } = {}) {
    const file = await this.getFile(fileOrId);
    if (!file) {
      throw new Error('File not found');
    }

    const fileContent = await this.getOrCreateFileContent(file._id);

    if (!force && fileContent.extractionStatus === 'completed' && fileContent.extractedText && fileContent.extractedText.trim().length > 0) {
      return {
        success: true,
        cached: true,
        text: fileContent.extractedText,
        fileContent,
        extractionMethod: fileContent.extractionMethod || 'cached',
      };
    }

    fileContent.extractionStatus = 'pending';
    await fileContent.save();

    if (!await fs.pathExists(file.path)) {
      fileContent.extractionStatus = 'failed';
      await fileContent.save();
      return {
        success: false,
        cached: false,
        text: '',
        fileContent,
        extractionMethod: '',
        error: 'File not found on disk.',
      };
    }

    try {
      const result = await textExtractor.extractTextWithMetadata(file.path, file.mimeType, file.originalName);
      const extractedText = (result.text || '').trim();

      if (!extractedText) {
        fileContent.extractedText = '';
        fileContent.embedding = [];
        fileContent.extractedAt = new Date();
        fileContent.extractionStatus = 'failed';
        fileContent.extractionMethod = result.method || '';
        await fileContent.save();

        return {
          success: false,
          cached: false,
          text: '',
          fileContent,
          extractionMethod: result.method || '',
          error: result.error || 'No text could be extracted from this file.',
        };
      }

      const embedding = await aiSearch.generateEmbedding(extractedText);

      fileContent.extractedText = extractedText;
      fileContent.embedding = embedding;
      fileContent.extractedAt = new Date();
      fileContent.extractionStatus = 'completed';
      fileContent.extractionMethod = result.method || '';
      this.clearSummaryState(fileContent);
      await fileContent.save();

      return {
        success: true,
        cached: false,
        text: extractedText,
        fileContent,
        extractionMethod: result.method || '',
      };
    } catch (error) {
      fileContent.extractionStatus = 'failed';
      await fileContent.save();

      return {
        success: false,
        cached: false,
        text: '',
        fileContent,
        extractionMethod: '',
        error: error.message || 'Failed to extract text from this file.',
      };
    }
  }
}

module.exports = new DocumentProcessingService();
