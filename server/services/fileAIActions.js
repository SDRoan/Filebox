const fs = require('fs-extra');
const config = require('../config/aiConfig');
const ollamaClient = require('./ollamaClient');
const assistant = require('./ollamaWorkspaceAssistant');

/**
 * File-type-specific "Ask File Box AI" actions. Each action runs locally:
 * text extraction uses Tesseract/pdf-parse/Mammoth, everything else uses Ollama.
 * Callers must authorize the file first (viewer access is enough: these actions only read).
 */

const DOCUMENT_EXT = ['pdf', 'doc', 'docx', 'odt', 'rtf'];
const CODE_EXT = ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'dart', 'lua', 'r', 'm', 'pl', 'yaml', 'yml', 'toml', 'xml', 'json'];
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'log', 'ini', 'cfg', 'tex'];
const IMAGE_OCR_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp'];

const extensionOf = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function kindOf(file) {
  const ext = extensionOf(file.originalName);
  const mime = (file.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('opendocument.text') || DOCUMENT_EXT.includes(ext)) return 'document';
  if (CODE_EXT.includes(ext) || /javascript|typescript|x-python|x-sh|json|xml/.test(mime)) return 'code';
  if (mime.startsWith('text/') || TEXT_EXT.includes(ext)) return 'text';
  return 'other';
}

// Prompts are fixed per action; the model only sees the file's own text.
const PROMPTS = {
  summarize: 'Summarize this file in plain English: what it is, its main points, and why it matters. Use a short paragraph and a few bullets. Only use information in the text.',
  explain_simply: 'Explain this document in simple language for someone with no background in the topic. Avoid jargon; define any term you must use. Only use information in the text.',
  key_points: 'List the key points of this file as 4-8 short bullets, most important first. Only use information in the text.',
  important_dates: 'List every date, deadline or time period mentioned in this file, each with what it refers to, as bullets in chronological order. If the text contains no dates, say exactly: "No dates are mentioned in this file." Do not invent dates.',
  find_sections: 'Identify the most important sections or parts of this file. For each, give its heading or a short identifier and one sentence on why it matters. Only use information in the text.',
  explain_code: 'Explain what this code does: its purpose, the main functions or components, inputs and outputs, and anything risky or unusual. Be concrete and refer to names in the code.',
  summarize_text: 'This text was extracted from an image with OCR and may contain recognition errors. Summarize what the image says in a few sentences, noting if parts look garbled.',
};

const ACTION_LABELS = {
  summarize: 'Summarize',
  explain_simply: 'Explain simply',
  key_points: 'Key points',
  important_dates: 'Important dates',
  find_sections: 'Find important sections',
  explain_code: 'Explain code',
  extract_text: 'Extract text',
  summarize_text: 'Summarize extracted text',
  describe_image: 'Describe image',
};

const ACTIONS_BY_KIND = {
  document: ['summarize', 'explain_simply', 'key_points', 'important_dates'],
  code: ['explain_code', 'summarize', 'find_sections'],
  text: ['summarize', 'key_points', 'find_sections', 'important_dates'],
  image: ['extract_text', 'summarize_text', 'describe_image'],
  other: [],
};

const needsOllama = (action) => action !== 'extract_text';

// Which generation profile each action uses (see TASK_PROFILES in ollamaClient).
const ACTION_TASKS = {
  summarize: 'summarize',
  explain_simply: 'summarize',
  summarize_text: 'summarize',
  explain_code: 'answer',
  key_points: 'extract',
  important_dates: 'extract',
  find_sections: 'extract',
};

/** Actions this file supports, with availability given the current Ollama status. */
async function listActions(file) {
  const kind = kindOf(file);
  const health = await ollamaClient.health();
  const aiReady = Boolean(health.reachable && health.assistantModelAvailable);

  const actions = ACTIONS_BY_KIND[kind]
    .filter(action => !(action === 'extract_text' || action === 'summarize_text') || IMAGE_OCR_TYPES.includes((file.mimeType || '').toLowerCase()))
    // Image description is only offered when a local vision model is installed.
    .filter(action => action !== 'describe_image' || health.visionModelAvailable)
    .map(action => ({
      id: action,
      label: ACTION_LABELS[action],
      needsAI: needsOllama(action),
      available: !needsOllama(action) || aiReady,
    }));

  return {
    kind,
    aiReady,
    actions,
    // Questions go to the File Box AI chat with this file selected.
    canAsk: kind !== 'other' && aiReady,
  };
}

async function fileText(file) {
  const content = await assistant.ensureExtractedContent(file);
  return (content?.extractedText || '').trim();
}

/** Run one action. Throws errors with .status for the route to return. */
async function runAction(file, action) {
  const kind = kindOf(file);
  if (!ACTIONS_BY_KIND[kind].includes(action)) {
    throw Object.assign(new Error('That action is not available for this file type.'), { status: 400 });
  }

  if (action === 'extract_text') {
    const text = await fileText(file);
    return { action, result: text || 'No readable text was found in this image.', provider: 'local-ocr' };
  }

  const health = await ollamaClient.health();
  if (!health.reachable) {
    throw Object.assign(new Error('File Box AI is offline. Start Ollama on your computer to use this action.'), { status: 503, code: 'AI_OFFLINE' });
  }

  if (action === 'describe_image') {
    if (!health.visionModelAvailable) {
      throw Object.assign(new Error(`Image description needs the local model ${config.ollama.visionModel}.`), { status: 400 });
    }
    const filePath = await assistant.resolveFilePath(file);
    const image = (await fs.readFile(filePath)).toString('base64');
    const description = await ollamaClient.chat({
      task: 'describe',
      model: config.ollama.visionModel,
      keepAlive: '30s', // a large model only needed for this one request
      system: 'Describe images for a file storage product. Be factual and concise; do not guess names of people.',
      content: 'Describe this image in 2-4 sentences.',
      images: [image],
    });
    return { action, result: description.trim(), provider: 'ollama', model: config.ollama.visionModel };
  }

  const text = await fileText(file);
  if (!text) {
    throw Object.assign(new Error('No readable text was found in this file.'), { status: 422 });
  }

  const { text: result, trimmed } = await ollamaClient.generate({
    task: ACTION_TASKS[action],
    model: config.ollama.assistantModel,
    system: `You help people understand their files in File Box. ${PROMPTS[action]}`,
    content: `File name: ${file.originalName}\n\nFile text:`,
    context: text,
  });
  return { action, result: result.trim(), provider: 'ollama', model: config.ollama.assistantModel, truncated: trimmed };
}

/** Whether an action exists for this file's type (summarize, explain_code, ...). */
const supports = (file, action) => ACTIONS_BY_KIND[kindOf(file)].includes(action);

module.exports = { listActions, runAction, kindOf, supports };
