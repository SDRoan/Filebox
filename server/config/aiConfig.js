require('dotenv').config();

module.exports = {
  // File Box AI is local-only: every model call goes to Ollama on this machine.
  // There is intentionally no hosted-AI configuration here.

  // Ollama Configuration (local-first)
  ollama: {
    enabled: process.env.OLLAMA_ENABLED !== 'false',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ocrModel: process.env.OLLAMA_OCR_MODEL || 'glm-ocr',
    // Used for "Describe image" only when this model is installed locally.
    visionModel: process.env.OLLAMA_VISION_MODEL || 'llama3.2-vision',
    summaryModel: process.env.OLLAMA_SUMMARY_MODEL || 'llama3.1:8b',
    assistantModel: process.env.OLLAMA_ASSISTANT_MODEL || process.env.OLLAMA_SUMMARY_MODEL || 'llama3.1:8b',
    plannerModel: process.env.OLLAMA_ASSISTANT_PLANNER_MODEL || process.env.OLLAMA_ASSISTANT_MODEL || process.env.OLLAMA_SUMMARY_MODEL || 'llama3.1:8b',
    // Generation settings are per task in services/ollamaClient.js (TASK_PROFILES).
    // Explicit context window: Ollama's default (4096 tokens) silently cuts long prompts from the front.
    contextWindow: parseInt(process.env.OLLAMA_CONTEXT_WINDOW, 10) || 8192,
    // Fixed seed so the same request with the same files gives the same answer or plan.
    seed: Number.isFinite(parseInt(process.env.OLLAMA_SEED, 10)) ? parseInt(process.env.OLLAMA_SEED, 10) : 42,
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

  // Learning library (hidden with the other student features; see FILEBOX_ENABLE_STUDENT_FEATURES)
  learningResources: {
    enabled: process.env.AI_LEARNING_RESOURCES_ENABLED === 'true',
    count: parseInt(process.env.AI_LEARNING_RESOURCES_COUNT) || 7,
    updateInterval: process.env.AI_LEARNING_RESOURCES_INTERVAL || '0 0 * * *',
  },

  // Summarization Configuration (runs on Ollama's summary model)
  summarization: {
    enabled: process.env.AI_SUMMARIZATION_ENABLED !== 'false',
  }
};
