require('dotenv').config();

module.exports = {
  // OpenAI Configuration (Optional - paid)
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-ada-002',
  },

  // Hugging Face Configuration (Free tier available)
  huggingface: {
    apiKey: process.env.HUGGINGFACE_API_KEY || '',
    embeddingModel: process.env.HUGGINGFACE_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2',
    useFreeInference: process.env.USE_HUGGINGFACE_FREE === 'true' || !process.env.HUGGINGFACE_API_KEY,
  },

  // Ollama Configuration (local-first)
  ollama: {
    enabled: process.env.OLLAMA_ENABLED !== 'false',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ocrModel: process.env.OLLAMA_OCR_MODEL || 'glm-ocr',
    summaryModel: process.env.OLLAMA_SUMMARY_MODEL || 'llama3.1:8b',
    assistantModel: process.env.OLLAMA_ASSISTANT_MODEL || process.env.OLLAMA_SUMMARY_MODEL || 'llama3.1:8b',
    plannerModel: process.env.OLLAMA_ASSISTANT_PLANNER_MODEL || process.env.OLLAMA_ASSISTANT_MODEL || process.env.OLLAMA_SUMMARY_MODEL || 'llama3.1:8b',
    assistantTemperature: parseFloat(process.env.OLLAMA_ASSISTANT_TEMPERATURE || '0.25'),
    assistantHistoryTurns: parseInt(process.env.OLLAMA_ASSISTANT_HISTORY_TURNS, 10) || 8,
    assistantMaxFileContextChars: parseInt(process.env.OLLAMA_ASSISTANT_MAX_FILE_CONTEXT_CHARS, 10) || 12000,
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120000,
    fallbackEnabled: process.env.OLLAMA_FALLBACK_ENABLED !== 'false',
  },

  // Text Extraction Configuration
  extraction: {
    maxTextLength: parseInt(process.env.AI_MAX_TEXT_LENGTH) || 8000,
    ocrLanguage: process.env.OCR_LANGUAGE || 'eng',
    supportedMimeTypes: process.env.SUPPORTED_MIME_TYPES 
      ? process.env.SUPPORTED_MIME_TYPES.split(',')
      : [
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain',
          'text/html',
          'text/css',
          'text/javascript',
          'application/json',
          'application/xml',
          'image/jpeg',
          'image/png',
          'image/gif',
          'image/bmp',
          'image/tiff'
        ]
  },

  // Search Configuration
  search: {
    minSimilarityThreshold: parseFloat(process.env.AI_MIN_SIMILARITY_THRESHOLD) || 0.1,
    maxResults: parseInt(process.env.AI_MAX_SEARCH_RESULTS) || 20,
    folderSearchLimit: parseInt(process.env.AI_FOLDER_SEARCH_LIMIT) || 10,
    filenameSearchLimit: parseInt(process.env.AI_FILENAME_SEARCH_LIMIT) || 5,
    simpleEmbeddingMaxWords: parseInt(process.env.AI_SIMPLE_EMBEDDING_MAX_WORDS) || 100,
  },

  // Keyword Search Scoring Weights
  scoring: {
    exactFilenameMatch: parseInt(process.env.SCORE_EXACT_FILENAME_MATCH) || 10,
    partialFilenameMatch: parseInt(process.env.SCORE_PARTIAL_FILENAME_MATCH) || 5,
    contentMatch: parseFloat(process.env.SCORE_CONTENT_MATCH) || 0.5,
  },

  // Summarization Configuration
  summarization: {
    enabled: process.env.AI_SUMMARIZATION_ENABLED !== 'false', // Default: enabled
    model: process.env.AI_SUMMARIZATION_MODEL || 'facebook/bart-large-cnn', // Hugging Face model
    maxInputLength: parseInt(process.env.AI_SUMMARIZATION_MAX_INPUT_LENGTH) || 1024, // Max tokens for input
    maxSummaryLength: parseInt(process.env.AI_SUMMARIZATION_MAX_LENGTH) || 150, // Max tokens for summary
    minLength: parseInt(process.env.AI_SUMMARIZATION_MIN_LENGTH) || 30, // Min tokens for summary
    useFreeInference: process.env.USE_HUGGINGFACE_FREE === 'true' || !process.env.HUGGINGFACE_API_KEY,
    autoSummarize: process.env.AI_AUTO_SUMMARIZE !== 'false', // Auto-generate summaries on upload
  }
};
