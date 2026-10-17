const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const FileContent = require('../models/FileContent');
const FileSummary = require('../models/FileSummary');
const ollamaWorkspaceAssistant = require('../services/ollamaWorkspaceAssistant');
const config = require('../config/aiConfig');
const { authorizeFile, sendDenied } = require('../services/permissions');
const fileAIActions = require('../services/fileAIActions');
const { buildDuplicateSuggestions } = require('../services/duplicateSuggestions');
const { suggestOrganization, applyProposals } = require('../services/organizeSuggestions');

const sanitizeHistory = (history = []) =>
  (Array.isArray(history) ? history : [])
    .map((message) => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message?.content === 'string' ? message.content.trim() : '',
    }))
    .filter((message) => message.content);

const isId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

// Choices the user made from an earlier list. Only ids; the assistant re-checks access to each one.
const sanitizeResolved = (resolved) => {
  const files = {};
  if (resolved && typeof resolved.files === 'object' && resolved.files) {
    Object.entries(resolved.files).slice(0, 20).forEach(([name, id]) => {
      if (typeof name === 'string' && name.length <= 200 && isId(id)) files[name.toLowerCase()] = id;
    });
  }
  return { files, folder: isId(resolved?.folder) ? resolved.folder : undefined };
};

const sendAssistantError = (res, error) => {
  const message = error.message || 'The AI assistant could not complete this request.';
  const offline = /ollama|connect|unavailable|ECONNREFUSED|model/i.test(message);

  res.status(offline ? 503 : 500).json({
    code: offline ? 'AI_OFFLINE' : 'AI_ERROR',
    message,
    answer: offline
      ? 'File Box AI is offline. Start Ollama on your computer to use local AI features.'
      : message,
    provider: 'ollama',
    model: config.ollama.assistantModel,
    timestamp: new Date(),
  });
};

// Assistant health and model status
router.get('/status', auth, async (req, res) => {
  try {
    const status = await ollamaWorkspaceAssistant.getStatus();
    res.json({
      ...status,
      ready: Boolean(status.reachable && status.assistantModelAvailable),
      recommendedModels: {
        assistant: config.ollama.assistantModel,
        planner: config.ollama.plannerModel,
        summary: config.ollama.summaryModel,
      },
    });
  } catch (error) {
    res.status(500).json({
      message: error.message || 'Failed to check AI assistant status.',
      reachable: false,
      ready: false,
    });
  }
});

// Main Ollama-powered workspace copilot chat
router.post('/chat', auth, async (req, res) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const fileId = typeof req.body?.fileId === 'string' && req.body.fileId.trim() ? req.body.fileId.trim() : undefined;
    const context = typeof req.body?.context === 'string' ? req.body.context.trim() : '';
    const history = sanitizeHistory(req.body?.history);

    if (!question) {
      return res.status(400).json({
        message: 'Question is required.',
        answer: 'Ask me something about your drive, a file, or an action you want me to take.',
      });
    }

    const result = await ollamaWorkspaceAssistant.chat({
      userId: req.user._id,
      question,
      fileId,
      history,
      context,
      resolved: sanitizeResolved(req.body?.resolved),
    });

    res.json(result);
  } catch (error) {
    sendAssistantError(res, error);
  }
});

// Run a destructive or exposing action (trash, share) after the user confirmed it in the UI
router.post('/confirm', auth, async (req, res) => {
  try {
    const type = typeof req.body?.type === 'string' ? req.body.type : '';
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const fileId = typeof req.body?.fileId === 'string' && req.body.fileId.trim() ? req.body.fileId.trim() : undefined;
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds.filter(isId).slice(0, 20) : undefined;

    if (!type || !question) {
      return res.status(400).json({ message: 'Action type and original request are required.' });
    }

    const result = await ollamaWorkspaceAssistant.confirmAction({
      userId: req.user._id,
      type,
      question,
      fileId,
      fileIds,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message || 'Could not run this action.' });
  }
});

// Lightweight file insights for the assistant and preview surfaces
router.get('/insights/:fileId', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    const file = access.file.toObject();

    const [fileContent, legacySummary] = await Promise.all([
      FileContent.findOne({ file: file._id }).lean(),
      FileSummary.findOne({ file: file._id }).lean(),
    ]);

    const extractedText = fileContent?.extractedText?.trim() || '';
    const summaryText =
      fileContent?.summary?.trim() ||
      legacySummary?.summary?.trim() ||
      '';

    const keyPoints = legacySummary?.keyPoints?.length
      ? legacySummary.keyPoints
      : summaryText
        .split(/\n+/)
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 5);

    const wordCount =
      legacySummary?.wordCount ||
      (extractedText ? extractedText.split(/\s+/).filter(Boolean).length : 0);

    const readingTime =
      legacySummary?.readingTime ||
      (wordCount ? Math.max(1, Math.ceil(wordCount / 225)) : 0);

    const accessLog = Array.isArray(file.accessLog) ? file.accessLog : [];
    const suggestions = [];

    if (summaryText) {
      suggestions.push('Ask the assistant to explain this file in simpler terms.');
    }

    if (!summaryText && extractedText) {
      suggestions.push('Ask the assistant to summarize this file.');
    }

    if (wordCount > 1500) {
      suggestions.push('Use the assistant to pull out the most important sections before sharing.');
    }

    if (!accessLog.length) {
      suggestions.push('This file has not been opened yet in this workspace.');
    }

    res.json({
      file: {
        id: file._id.toString(),
        name: file.originalName,
        type: file.mimeType,
        size: file.size,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      },
      summary: summaryText
        ? {
            summary: summaryText,
            keyPoints,
            readingTime,
            wordCount,
            provider: fileContent?.summaryProvider || legacySummary?.model || '',
            model: fileContent?.summaryModel || legacySummary?.model || '',
            status: fileContent?.summaryStatus || 'completed',
          }
        : null,
      extraction: {
        status: fileContent?.extractionStatus || 'not_started',
        method: fileContent?.extractionMethod || '',
        textLength: extractedText.length,
      },
      access: {
        viewCount: accessLog.filter((entry) => entry.action === 'view').length,
        downloadCount: accessLog.filter((entry) => entry.action === 'download').length,
        lastAccessed: accessLog.length ? accessLog[accessLog.length - 1].timestamp : null,
      },
      suggestions,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to load file insights.' });
  }
});

// Errors from the Phase 3 services carry a status (and AI_OFFLINE code when Ollama is down).
const sendServiceError = (res, error, fallback) => {
  res.status(error.status || 500).json({ code: error.code, message: error.message || fallback });
};

// File-type-specific actions for one file. Reading is enough, so viewers may use them.
router.get('/file-actions/:fileId', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    if (access.file.isTrashed) return res.status(404).json({ message: 'File not found' });
    res.json(await fileAIActions.listActions(access.file));
  } catch (error) {
    sendServiceError(res, error, 'Could not load actions for this file.');
  }
});

router.post('/file-actions/:fileId', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    if (access.file.isTrashed) return res.status(404).json({ message: 'File not found' });
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    res.json(await fileAIActions.runAction(access.file, action));
  } catch (error) {
    sendServiceError(res, error, 'This action could not be completed.');
  }
});

// Duplicate cleanup suggestions for the user's own files. Never deletes anything.
router.get('/duplicates', auth, async (req, res) => {
  try {
    res.json(await buildDuplicateSuggestions(req.user._id, { explain: req.query.explain === '1' }));
  } catch (error) {
    sendServiceError(res, error, 'Could not check for duplicates.');
  }
});

// Organization: propose changes (nothing is applied) ...
router.post('/organize/suggest', auth, async (req, res) => {
  try {
    const folderId = typeof req.body?.folderId === 'string' && req.body.folderId ? req.body.folderId : null;
    res.json(await suggestOrganization(req.user._id, { folderId }));
  } catch (error) {
    sendServiceError(res, error, 'Could not prepare suggestions.');
  }
});

// ... and apply only the changes the user reviewed and confirmed.
router.post('/organize/apply', auth, async (req, res) => {
  try {
    const result = await applyProposals(req.user._id, { actions: req.body?.actions, confirm: req.body?.confirm });
    const io = req.app.get('io');
    result.results.filter(r => r.success && r.file).forEach(r => {
      io?.to(`user-${req.user._id}`).emit(r.type === 'move' ? 'file-moved' : 'file-renamed', r.file);
      delete r.file;
    });
    res.json(result);
  } catch (error) {
    sendServiceError(res, error, 'Could not apply these changes.');
  }
});

module.exports = router;
