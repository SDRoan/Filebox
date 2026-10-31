const express = require('express');
const router = express.Router();
const { getFileRole } = require('../services/permissions');
const auth = require('../middleware/auth');
const FileSummary = require('../models/FileSummary');
const File = require('../models/File');
const FileContent = require('../models/FileContent');
const textExtractor = require('../services/textExtractor');
const ollamaClient = require('../services/ollamaClient');
const config = require('../config/aiConfig');

// Get summary for file
router.get('/file/:fileId', auth, async (req, res) => {
  try {
    const file = await File.findById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }
    
    // Check permissions
    if (!(await getFileRole(file, req.user._id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    let summary = await FileSummary.findOne({ file: file._id });
    
    if (!summary) {
      // Generate summary
      return res.json({ 
        exists: false,
        message: 'Summary not generated yet. Use POST to generate.'
      });
    }
    
    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Generate summary for file
router.post('/file/:fileId', auth, async (req, res) => {
  try {
    const file = await File.findById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }
    
    // Check permissions
    if (!(await getFileRole(file, req.user._id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Check if summary exists
    let summary = await FileSummary.findOne({ file: file._id });
    
    if (summary) {
      return res.json(summary);
    }
    
    // Extract text from file
    let fileContent = await FileContent.findOne({ file: file._id });
    let extractedText = '';
    
    if (fileContent && fileContent.extractedText) {
      extractedText = fileContent.extractedText;
    } else {
      // Try to extract text
      try {
        extractedText = await textExtractor.extractText(file.path, file.mimeType);
      } catch (error) {
        return res.status(400).json({ 
          message: 'Could not extract text from this file type' 
        });
      }
    }
    
    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ 
        message: 'File does not contain enough text to summarize' 
      });
    }
    
    // Generate summary with local AI. Without Ollama, report that instead of saving a fake summary.
    const health = await ollamaClient.health();
    if (!health.reachable) {
      return res.status(503).json({
        code: 'AI_OFFLINE',
        message: 'File Box AI is offline. Start Ollama on your computer to generate summaries.'
      });
    }

    try {
      const summaryText = await generateSummary(file, extractedText);
      const keyPoints = extractKeyPoints(extractedText);
      const extractedData = extractData(extractedText);
      
      const wordCount = extractedText.split(/\s+/).length;
      const readingTime = Math.ceil(wordCount / 200); // Average reading speed
      
      summary = new FileSummary({
        file: file._id,
        summary: summaryText,
        keyPoints: keyPoints,
        extractedData: extractedData,
        wordCount: wordCount,
        readingTime: readingTime,
        language: detectLanguage(extractedText),
        model: config.ollama.summaryModel
      });
      
      await summary.save();
      res.json(summary);
    } catch (error) {
      console.error('Error generating summary:', error);
      res.status(500).json({ message: 'Failed to generate summary', error: error.message });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Summarize with the local Ollama summary model
async function generateSummary(file, text) {
  const summary = await ollamaClient.chatText({
    task: 'summarize',
    model: config.ollama.summaryModel,
    system: 'You summarize files for a cloud storage product. Write a short plain-English summary: what the document is, its main points, and why it matters. Stay grounded in the text.',
    content: `File name: ${file.originalName}\n\nDocument text:`,
    context: text,
  });

  if (!summary.trim()) {
    throw new Error('Ollama returned an empty summary.');
  }
  return summary.trim();
}

// Extract key points
function extractKeyPoints(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  return sentences.slice(0, 5).map(s => s.trim());
}

// Extract structured data
function extractData(text) {
  // Simple regex-based extraction
  const dateRegex = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g;
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  const amountRegex = /\$\d+[\d,]*\.?\d*/g;
  
  return {
    dates: [...new Set(text.match(dateRegex) || [])].slice(0, 10),
    people: [], // Would need NER model for this
    topics: extractTopics(text),
    amounts: [...new Set(text.match(amountRegex) || [])].slice(0, 10),
    locations: [] // Would need NER model for this
  };
}

function extractTopics(text) {
  // Simple keyword extraction
  const words = text.toLowerCase().split(/\s+/);
  const wordFreq = {};
  words.forEach(word => {
    if (word.length > 4) {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }
  });
  
  return Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

function detectLanguage(text) {
  // Simple detection - could use a library
  return 'en'; // Default to English
}

module.exports = router;
