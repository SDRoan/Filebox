const path = require('path');
const fs = require('fs-extra');
const File = require('../models/File');
const Folder = require('../models/Folder');
const FileContent = require('../models/FileContent');
const FileMemory = require('../models/FileMemory');
const aiActionExecutor = require('./aiActionExecutor');
const textExtractor = require('./textExtractor');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { chunkText } = require('../utils/chunkText');
const { searchWorkspace } = require('./workspaceSearch');
const { readableFileFilter } = require('./permissions');
const { buildDuplicateSuggestions } = require('./duplicateSuggestions');
const { logFileBoxAction } = require('./activityLog');

const ACTION_TYPES = [
  'create_relationship',
  'delete_file',
  'create_file',
  'create_folder',
  'star_file',
  'share_file',
  'move_file',
  'rename_file',
  'create_file_request',
  'create_shortcut',
  'create_secured_link',
  'create_template',
  'create_team_folder',
  'create_cloud_backup',
  'none',
];

// Actions that remove or expose files. The assistant describes them and waits for the user to confirm.
const CONFIRMATION_REQUIRED_ACTIONS = ['delete_file', 'share_file'];

const FIND_HINT_REGEX = /\b(find|search|look for|locate|where is|where's|which (?:file|document|pdf)s?|show me (?:my|the))\b/i;
const SUMMARY_HINT_REGEX = /(summar(?:ize|y)|what is this|what is in|tell me about this file|explain this file|what does this file say|give me the gist)/i;
const FILE_CONTEXT_HINT_REGEX = /(\bthis file\b|\bthis document\b|\bselected file\b|\bpdf\b|\bdocx?\b|\bdocument\b|\bresume\b|\breport\b|\bnotes?\b)/i;

const stripFences = (value = '') =>
  value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

const safeJsonParse = (value, fallback = null) => {
  try {
    return JSON.parse(stripFences(value));
  } catch (error) {
    return fallback;
  }
};

const truncateText = (value = '', limit = 2400) => {
  if (!value) {
    return '';
  }

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit).trim()}\n...[truncated]`;
};

const formatBytes = (bytes = 0) => {
  if (!bytes) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${Math.round(value * 100) / 100} ${units[exponent]}`;
};

class OllamaWorkspaceAssistant {
  questionIsHowTo(question = '') {
    return /(^|\b)(how do i|how can i|how to|steps|walk me through|guide me|where do i|what do i click|show me how)\b/i.test(question);
  }

  questionLooksActionable(question = '') {
    return /\b(create|make|rename|move|delete|remove|trash|share|star|favorite|bookmark|upload|set up|setup|schedule|add|save|generate|turn|convert|relate|link|connect|backup|summarize)\b/i.test(question);
  }

  buildUnsupportedActionAnswer() {
    return "I couldn't perform that inside File Box yet. I can create, rename, move, star, share and trash files, create folders, file requests, shortcuts, secured links, templates, team spaces and backups.";
  }

  cleanActionMessage(message = '') {
    return (message || '')
      .replace(/^✅\s*/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  formatActionAnswer(actionType, actionResult) {
    const safeMessage = this.cleanActionMessage(actionResult?.message || 'The action finished.');

    // A question back to the user (which file? whose email?) is not a failure.
    if (actionResult?.needsInput) {
      return safeMessage;
    }

    if (!actionResult?.success) {
      return `I couldn't complete that action. ${safeMessage}`;
    }

    switch (actionType) {
      case 'create_file': {
        const fileName = actionResult?.data?.fileName || 'the file';
        return `Created the file "${fileName}" for you.`;
      }
      case 'create_folder': {
        const folderName = actionResult?.data?.folderName || 'the folder';
        return `Created the folder "${folderName}" for you. It is in your drive now.`;
      }
      case 'rename_file': {
        const oldName = actionResult?.data?.oldName;
        const newName = actionResult?.data?.newName;
        if (oldName && newName) {
          return `Renamed "${oldName}" to "${newName}" for you.`;
        }
        return safeMessage;
      }
      case 'move_file': {
        const targetFolder = actionResult?.data?.targetFolder;
        const movedFiles = actionResult?.data?.movedFiles || [];
        if (movedFiles.length && targetFolder) {
          return `Moved ${movedFiles.join(', ')} to "${targetFolder}" for you.`;
        }
        return safeMessage;
      }
      case 'share_file': {
        const sharedWith = actionResult?.data?.sharedWith;
        if (sharedWith) {
          return `Shared the file for you with ${sharedWith}.`;
        }
        if (actionResult?.data?.shareLinks?.length) {
          return `Created share link${actionResult.data.shareLinks.length > 1 ? 's' : ''} for you.`;
        }
        return safeMessage;
      }
      case 'create_file_request': {
        const title = actionResult?.data?.title || 'the file request';
        const requestId = actionResult?.data?.requestId;
        return requestId
          ? `Created the file request "${title}" for you. Request link id: ${requestId}.`
          : `Created the file request "${title}" for you.`;
      }
      case 'create_shortcut': {
        const title = actionResult?.data?.title || 'the shortcut';
        return `Created the shortcut "${title}" for you.`;
      }
      case 'create_secured_link': {
        const title = actionResult?.data?.title || 'the secured link';
        return `Created the secured link "${title}" for you.`;
      }
      case 'create_template': {
        const templateName = actionResult?.data?.templateName || 'the template';
        return `Created the template "${templateName}" for you.`;
      }
      case 'create_team_folder': {
        const teamFolderName = actionResult?.data?.teamFolderName || 'the team space';
        return `Created the team space "${teamFolderName}" for you.`;
      }
      case 'create_cloud_backup': {
        const sourceType = actionResult?.data?.sourceType || 'backup';
        return `Set up the ${sourceType} cloud backup for you.`;
      }
      case 'star_file':
      case 'delete_file':
      case 'create_relationship':
      default:
        return safeMessage;
    }
  }

  // Files the assistant may read: the shared permission rules (owned, shared with the user, Team Spaces).
  getAccessibleFileQuery(userId) {
    return readableFileFilter(userId);
  }

  questionIsSearch(question = '') {
    return FIND_HINT_REGEX.test(question);
  }

  extractSearchQuery(question = '') {
    const query = question
      .replace(/^(please\s+)?(can you\s+)?(find|search(?:\s+for)?|look\s+for|locate|show\s+me|where\s+is|where's)\s+/i, '')
      .replace(/\b(my|the|a|an|all|files?|documents?|that|which|mentions?|mentioning|about|related\s+to|in\s+my\s+drive)\b/gi, ' ')
      .replace(/[?.!,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return query || question;
  }

  // "Find X", "where is X", "find X in Trash" -- but not "find X and delete it".
  questionIsPlainFind(question = '') {
    if (!this.questionIsSearch(question) || this.questionNeedsSummary(question)) return false;
    const withoutTrashScope = question.replace(/\b(in|from)\s+(the\s+)?(trash|bin)\b/gi, ' ');
    return !this.questionLooksActionable(withoutTrashScope);
  }

  questionAsksForTrash(question = '') {
    return /\b(trash|trashed|deleted|bin)\b/i.test(question);
  }

  // Search everything the user may read (owned, shared with them, Team Spaces), using the shared permission rules.
  async searchForQuestion(userId, question) {
    const includeTrash = this.questionAsksForTrash(question);
    const query = this.extractSearchQuery(question).replace(/\b(in\s+)?(the\s+)?(trash|trashed|deleted|bin)\b/gi, ' ').replace(/\s+/g, ' ').trim() || question;
    const { files } = await searchWorkspace(userId, query, { limit: 8, scope: 'accessible', includeTrash });
    return files.map((file) => {
      const { source, role, teamName } = file.access;
      const ownerName = file.owner?.name;
      let location = file.folderName || 'My Files';
      if (source === 'team') location = teamName ? `Team Space: ${teamName}` : 'Team Space';
      if (source === 'shared') location = ownerName ? `Shared by ${ownerName}` : 'Shared with you';
      if (file.isTrashed) location = 'Trash';
      return {
        id: file._id.toString(),
        name: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        source,
        role,
        ownerName: source === 'owned' ? undefined : ownerName,
        teamName,
        trashed: Boolean(file.isTrashed),
        folder: location,
        // Only meaningful for the user's own files; used to open the folder in My Files.
        parentFolder: source === 'owned' && !file.isTrashed ? (file.parentFolder?.toString() || null) : null,
        updatedAt: file.updatedAt,
      };
    });
  }

  findAnswer(question, files) {
    const query = this.extractSearchQuery(question);
    if (!files.length) {
      return `I couldn't find any files matching "${query}" in your files, files shared with you, or your Team Spaces.`;
    }
    const counts = ['owned', 'shared', 'team']
      .map(source => [source, files.filter(f => f.source === source && !f.trashed).length])
      .filter(([, n]) => n);
    const labels = { owned: 'yours', shared: 'shared with you', team: 'in Team Spaces' };
    const breakdown = counts.map(([source, n]) => `${n} ${labels[source]}`).join(', ');
    const trashed = files.filter(f => f.trashed).length;
    return `I found ${files.length} file${files.length === 1 ? '' : 's'} matching "${query}"${breakdown ? ` (${breakdown}${trashed ? `, ${trashed} in Trash` : ''})` : trashed ? ' in Trash' : ''}. Select one to open it, or ask me about it.`;
  }

  questionNeedsSummary(question = '') {
    return SUMMARY_HINT_REGEX.test(question);
  }

  questionNeedsFileContext(question = '', hasSelectedFile = false) {
    return hasSelectedFile || FILE_CONTEXT_HINT_REGEX.test(question) || this.questionNeedsSummary(question);
  }

  normalizePlannerDecision(rawDecision, question, hasSelectedFile) {
    const parsed = typeof rawDecision === 'string'
      ? safeJsonParse(rawDecision, {})
      : (rawDecision || {});

    const fallbackAction = aiActionExecutor.parseAction(question);
    const fallbackIsSummary = this.questionNeedsSummary(question);
    const fallbackNeedsFileContext = this.questionNeedsFileContext(question, hasSelectedFile);
    const isHowTo = this.questionIsHowTo(question);
    const isActionRequest = this.questionLooksActionable(question) && !isHowTo && !fallbackIsSummary;
    const shouldPreferFallbackAction = Boolean(fallbackAction && isActionRequest);

    const parsedToolAction = ACTION_TYPES.includes(parsed.toolAction)
      ? parsed.toolAction
      : 'none';
    const toolAction = parsedToolAction !== 'none'
      ? parsedToolAction
      : (fallbackAction?.type || 'none');

    let confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : (fallbackAction?.confidence || 0);

    if (toolAction !== 'none' && isActionRequest) {
      confidence = Math.max(confidence, fallbackAction?.confidence || 0.84);
    }

    let intent = typeof parsed.intent === 'string' ? parsed.intent : '';
    if (!intent) {
      if (fallbackIsSummary) {
        intent = 'summarize';
      } else if (isActionRequest) {
        intent = 'action';
      } else {
        intent = 'answer';
      }
    } else if (
      (shouldPreferFallbackAction || isActionRequest) &&
      !['action', 'mixed', 'clarify', 'summarize'].includes(intent)
    ) {
      intent = 'action';
    }

    return {
      intent,
      toolAction,
      confidence,
      shouldExecuteAction: shouldPreferFallbackAction
        ? true
        : (parsed.shouldExecuteAction !== false && toolAction !== 'none' && isActionRequest),
      needsFileContext: typeof parsed.needsFileContext === 'boolean'
        ? parsed.needsFileContext
        : fallbackNeedsFileContext,
      responseMode: parsed.responseMode === 'steps' ? 'steps' : 'chat',
      clarifyingQuestion: typeof parsed.clarifyingQuestion === 'string' ? parsed.clarifyingQuestion.trim() : '',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  }

  async resolveFilePath(file) {
    const ownerId = typeof file.owner === 'object' && file.owner?._id
      ? file.owner._id.toString()
      : file.owner.toString();

    const candidates = [];

    if (file.path) {
      candidates.push(file.path);

      if (!path.isAbsolute(file.path)) {
        candidates.push(path.resolve(process.cwd(), file.path));
        candidates.push(path.resolve(__dirname, '..', file.path));
      }
    }

    if (file.name) {
      candidates.push(path.join(__dirname, '..', 'uploads', ownerId, file.name));
      candidates.push(path.join(process.cwd(), 'uploads', ownerId, file.name));
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (await fs.pathExists(candidate)) {
        return candidate;
      }
    }

    throw new Error(`File "${file.originalName}" could not be located on disk.`);
  }

  async ensureExtractedContent(file) {
    let fileContent = await FileContent.findOne({ file: file._id });
    if (fileContent?.extractedText?.trim()) {
      return fileContent;
    }

    const resolvedPath = await this.resolveFilePath(file);
    const extraction = await textExtractor.extractTextWithMetadata(
      resolvedPath,
      file.mimeType,
      file.originalName
    );

    if (!fileContent) {
      fileContent = new FileContent({ file: file._id });
    }

    fileContent.extractedText = extraction.text || '';
    fileContent.extractionMethod = extraction.method || '';
    fileContent.extractionStatus = extraction.text ? 'completed' : 'failed';
    fileContent.extractedAt = new Date();
    await fileContent.save();

    return fileContent;
  }

  async summarizeDocument(file, fileContent) {
    if (fileContent?.summaryStatus === 'completed' && fileContent.summary?.trim()) {
      return fileContent.summary.trim();
    }

    const sourceText = fileContent?.extractedText?.trim() || '';
    if (!sourceText) {
      return '';
    }

    fileContent.summaryStatus = 'pending';
    fileContent.summaryError = '';
    await fileContent.save();

    try {
      const model = config.ollama.summaryModel || config.ollama.assistantModel;
      let summary = '';

      if (sourceText.length <= 6500) {
        summary = await ollamaClient.chatText({
          task: 'summarize',
          model,
          system: 'You summarize files for a cloud storage copilot. Write a short but rich summary in plain English with the document purpose, main points, and why it matters. Stay grounded in the text.',
          content: `File name: ${file.originalName}\nFile type: ${file.mimeType}\n\nDocument text:`,
          context: sourceText,
        });
      } else {
        const chunks = chunkText(sourceText, 4500).slice(0, 8);
        const chunkSummaries = [];

        for (let index = 0; index < chunks.length; index += 1) {
          const chunkSummary = await ollamaClient.chatText({
            task: 'summarize',
            model,
            system: 'You summarize one chunk of a larger document. Capture the important facts, arguments, and signals in 5-7 sentences.',
            content: `File name: ${file.originalName}\nChunk ${index + 1} of ${chunks.length}`,
            context: chunks[index],
          });

          if (chunkSummary?.trim()) {
            chunkSummaries.push(`Chunk ${index + 1}: ${chunkSummary.trim()}`);
          }
        }

        summary = await ollamaClient.chatText({
          task: 'summarize',
          model,
          system: 'Combine chunk summaries into one coherent file summary for a cloud storage copilot. Explain what the file is, the main points, and why it matters. Use a few short paragraphs.',
          content: `File name: ${file.originalName}`,
          context: chunkSummaries.join('\n\n'),
        });
      }

      const cleanSummary = (summary || '').trim();

      fileContent.summary = cleanSummary;
      fileContent.summaryStatus = cleanSummary ? 'completed' : 'failed';
      fileContent.summaryProvider = 'ollama';
      fileContent.summaryModel = model;
      fileContent.summaryGeneratedAt = cleanSummary ? new Date() : undefined;
      fileContent.summaryError = cleanSummary ? '' : 'Ollama returned an empty summary.';
      await fileContent.save();

      return cleanSummary;
    } catch (error) {
      fileContent.summaryStatus = 'failed';
      fileContent.summaryError = error.message || 'Failed to summarize file.';
      await fileContent.save();
      return '';
    }
  }

  async buildWorkspaceSnapshot(userId) {
    const ownedFileQuery = { owner: userId, isTrashed: { $ne: true } };
    const ownedFolderQuery = { owner: userId, isTrashed: { $ne: true } };

    const [
      fileCount,
      folderCount,
      starredCount,
      sharedWithUserCount,
      recentFiles,
      recentFolders,
    ] = await Promise.all([
      File.countDocuments(ownedFileQuery),
      Folder.countDocuments(ownedFolderQuery),
      File.countDocuments({ ...ownedFileQuery, isStarred: true }),
      File.countDocuments({ 'sharedWith.user': userId, isTrashed: { $ne: true } }),
      File.find(ownedFileQuery)
        .sort({ updatedAt: -1 })
        .select('_id originalName mimeType size updatedAt')
        .limit(8)
        .lean(),
      Folder.find(ownedFolderQuery)
        .sort({ updatedAt: -1 })
        .select('_id name updatedAt')
        .limit(5)
        .lean(),
    ]);

    return {
      fileCount,
      folderCount,
      starredCount,
      sharedWithUserCount,
      recentFiles: recentFiles.map((file) => ({
        id: file._id.toString(),
        name: file.originalName,
        mimeType: file.mimeType,
        size: formatBytes(file.size),
        updatedAt: file.updatedAt,
      })),
      recentFolders: recentFolders.map((folder) => ({
        id: folder._id.toString(),
        name: folder.name,
        updatedAt: folder.updatedAt,
      })),
    };
  }

  async findReferencedFile(userId, fileId, question) {
    if (fileId) {
      return File.findOne({
        _id: fileId,
        ...(await this.getAccessibleFileQuery(userId)),
      }).lean();
    }

    const referencedFiles = aiActionExecutor.extractFileNames(question) || [];
    if (referencedFiles.length === 0) {
      return null;
    }

    for (const fileName of referencedFiles) {
      const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const file = await File.findOne({
        ...(await this.getAccessibleFileQuery(userId)),
        originalName: { $regex: escaped, $options: 'i' },
      }).lean();

      if (file) {
        return file;
      }
    }

    return null;
  }

  formatMemoryContext(memory) {
    if (!memory) {
      return '';
    }

    const lines = [];
    if (memory.creationContext?.userAction) {
      lines.push(`Why it was saved: ${memory.creationContext.userAction}`);
    }
    if (memory.creationContext?.projectContext) {
      lines.push(`Project: ${memory.creationContext.projectContext}`);
    }
    if (memory.creationContext?.meetingContext) {
      lines.push(`Meeting or event: ${memory.creationContext.meetingContext}`);
    }
    if (memory.aiInsights?.purpose) {
      lines.push(`Detected purpose: ${memory.aiInsights.purpose}`);
    }
    if (memory.userNotes?.length) {
      lines.push(`Latest note: ${memory.userNotes[memory.userNotes.length - 1].content}`);
    }

    return lines.join('\n');
  }

  async buildFileContext(userId, file, question) {
    const fileContent = await this.ensureExtractedContent(file);
    const memory = await FileMemory.findOne({ file: file._id, owner: userId }).lean();
    const extractedText = fileContent?.extractedText?.trim() || '';
    const shouldSummarize = this.questionNeedsSummary(question) || extractedText.length > 5000;
    const cachedOrGeneratedSummary = shouldSummarize
      ? await this.summarizeDocument(file, fileContent)
      : (fileContent.summary?.trim() || '');

    const sections = [
      `Selected file: ${file.originalName}`,
      `Type: ${file.mimeType}`,
      `Size: ${formatBytes(file.size)}`,
    ];

    if (cachedOrGeneratedSummary) {
      sections.push(`Summary:\n${cachedOrGeneratedSummary}`);
    }

    if (extractedText) {
      sections.push(`Excerpt:\n${truncateText(extractedText, config.ollama.assistantMaxFileContextChars)}`);
    }

    const memoryContext = this.formatMemoryContext(memory);
    if (memoryContext) {
      sections.push(`File memory:\n${memoryContext}`);
    }

    return sections.join('\n\n');
  }

  serializeConversation(history = []) {
    return history
      .slice(-config.ollama.assistantHistoryTurns)
      .map((message) => {
        const role = message.role === 'assistant' ? 'Assistant' : 'User';
        return `${role}: ${message.content}`;
      })
      .join('\n');
  }

  async planTurn({ question, history, workspaceSnapshot, selectedFile, context }) {
    const plannerPrompt = {
      question,
      context: context || '',
      selectedFile: selectedFile
        ? {
            name: selectedFile.originalName,
            mimeType: selectedFile.mimeType,
            size: formatBytes(selectedFile.size),
          }
        : null,
      recentConversation: history.slice(-config.ollama.assistantHistoryTurns),
      workspaceSnapshot,
      supportedActions: ACTION_TYPES.filter((action) => action !== 'none'),
    };

    const plannerResponse = await ollamaClient.chatText({
      model: config.ollama.plannerModel,
      system: `You are the planning layer for File Box Copilot, a local Ollama-powered assistant inside a cloud storage website.

Return JSON only.

Choose one intent:
- "answer" for normal ChatGPT-style guidance or explanation
- "summarize" when the user wants the meaning or summary of a specific file
- "action" when the user wants you to do something right now in the website
- "mixed" when you should execute one action and also explain the result
- "clarify" when you need the user to choose a file or be more specific

Supported toolAction values:
${ACTION_TYPES.join(', ')}

Rules:
- For "how do I" questions, do not execute actions.
- For direct commands like create, rename, move, delete, share, set up, schedule, save, upload, or make, prefer intent "action".
- Do not turn executable website commands into tutorials or click-by-click guidance.
- If the action is possible but you need one missing detail, choose intent "clarify".
- If the request is an action but no supported toolAction fits, still choose intent "action" with toolAction "none".
- If the user says "this file" or wants a summary but no file is selected, choose intent "clarify".
- Keep responseMode "steps" for procedural guidance and "chat" for normal answers.

JSON shape:
{
  "intent": "answer",
  "toolAction": "none",
  "confidence": 0.0,
  "shouldExecuteAction": false,
  "needsFileContext": false,
  "responseMode": "chat",
  "clarifyingQuestion": "",
  "reasoning": ""
}`,
      task: 'plan',
      content: JSON.stringify(plannerPrompt, null, 2),
      format: 'json',
    });

    return this.normalizePlannerDecision(plannerResponse, question, Boolean(selectedFile));
  }

  async composeAnswer({
    question,
    history,
    workspaceSnapshot,
    selectedFile,
    fileContext,
    actionResult,
    planningDecision,
    context,
  }) {
    const workspaceSummary = [
      `Files: ${workspaceSnapshot.fileCount}`,
      `Folders: ${workspaceSnapshot.folderCount}`,
      `Starred: ${workspaceSnapshot.starredCount}`,
      `Shared with user: ${workspaceSnapshot.sharedWithUserCount}`,
      `Recent files: ${workspaceSnapshot.recentFiles.map((file) => file.name).join(', ') || 'None'}`,
      `Recent folders: ${workspaceSnapshot.recentFolders.map((folder) => folder.name).join(', ') || 'None'}`,
    ].join('\n');

    const toolSummary = actionResult
      ? `Tool action attempted: ${planningDecision.toolAction}
Action success: ${actionResult.success ? 'yes' : 'no'}
Action message: ${actionResult.message}
Action data: ${JSON.stringify(actionResult.data || {}, null, 2)}`
      : 'No action was executed.';

    const response = await ollamaClient.chatText({
      model: config.ollama.assistantModel,
      system: `You are File Box Copilot, an Ollama-powered assistant inside a cloud storage website.

Behave like ChatGPT for this product:
- answer naturally and clearly
- stay grounded in the user's actual workspace context
- help with storage, sharing, file understanding, and website actions
- act like an AI version of the user across the available website features
- when a tool action was already executed, explain what happened in plain language
- never claim an action succeeded unless the tool summary says it did
- only give steps for explicit how-to questions
- for direct commands, do the action when available instead of describing manual clicks
- never tell the user how to click around the UI for an action the website assistant can perform
- when summarizing a file, explain what it is about and the main points in plain English

Keep answers concise but useful. Prefer short paragraphs. Use bullets only when they help.`,
      content: `Planning decision:
${JSON.stringify(planningDecision, null, 2)}

Workspace snapshot:
${workspaceSummary}

${context ? `Additional UI context:\n${context}\n` : ''}

${selectedFile ? `Selected file metadata:\nName: ${selectedFile.originalName}\nType: ${selectedFile.mimeType}\nSize: ${formatBytes(selectedFile.size)}\n` : ''}
{{CONTEXT}}

Tool summary:
${toolSummary}

Recent conversation:
${this.serializeConversation(history) || 'No prior conversation.'}

Latest user request:
${question}

Respond to the latest user request now.`,
      task: 'answer',
      // File text is the only part that may be trimmed to fit; rules and the request never are.
      context: fileContext ? `Selected file context:\n${fileContext}` : '',
    });

    return response.trim();
  }

  async getStatus() {
    const health = await ollamaClient.health();
    return {
      ...health,
      assistantModel: config.ollama.assistantModel,
      plannerModel: config.ollama.plannerModel,
      assistantMode: 'operator-mode',
    };
  }

  async buildConfirmationRequest(actionType, question, userId, actionContext) {
    const reply = {
      provider: 'ollama',
      model: config.ollama.assistantModel,
      fileId: actionContext.selectedFileId,
      timestamp: new Date(),
    };

    // "Share X with Sarah" without an email: ask for it; never fall back to a public link.
    if (actionType === 'share_file') {
      const recipientQuestion = aiActionExecutor.shareRecipientQuestion(question);
      if (recipientQuestion) return { ...reply, answer: recipientQuestion, needsInput: 'email' };
    }

    const targets = await aiActionExecutor.describeTargets(question, userId, actionContext);

    if (!targets.length) {
      return {
        ...reply,
        answer: "I couldn't find a file you own that matches. Mention the file name or select the file first.",
      };
    }

    const fileList = targets.map((name) => `"${name}"`).join(', ');
    const email = aiActionExecutor.extractEmail(question);
    let answer;
    if (actionType === 'delete_file') {
      answer = `I'm about to move ${fileList} to Trash. You can restore ${targets.length > 1 ? 'them' : 'it'} from Trash for 30 days.`;
    } else if (email) {
      answer = `I'm about to share ${fileList} with ${email} (view only).`;
    } else {
      answer = `I'm about to create a view-only share link for ${fileList}. Anyone with the link can open ${targets.length > 1 ? 'these files' : 'this file'}.`;
    }

    return {
      ...reply,
      answer,
      pendingAction: {
        type: actionType,
        question,
        fileId: actionContext.selectedFileId,
        targets,
      },
    };
  }

  /**
   * Run an action the user explicitly confirmed. The executor re-checks ownership.
   */
  async confirmAction({ userId, type, question, fileId }) {
    if (!CONFIRMATION_REQUIRED_ACTIONS.includes(type)) {
      throw new Error('This action does not need confirmation.');
    }

    const selectedFile = fileId
      ? await File.findOne({ _id: fileId, owner: userId, isTrashed: { $ne: true } }).lean()
      : null;
    const actionResult = await aiActionExecutor.executeAction(
      { type, confidence: 1 },
      question,
      userId,
      { selectedFileId: selectedFile?._id?.toString() || null, selectedFile }
    );
    if (actionResult.success) await logFileBoxAction(userId, type, actionResult.data);

    return {
      answer: this.formatActionAnswer(type, actionResult),
      provider: 'ollama',
      model: config.ollama.assistantModel,
      action: {
        type,
        success: actionResult.success,
        data: actionResult.data,
        error: actionResult.success ? undefined : actionResult.message,
      },
      fileId: selectedFile?._id || null,
      timestamp: new Date(),
    };
  }

  async chat({ userId, question, fileId, history = [], context = '' }) {
    // Duplicate cleanup is rule-based and review-only: show the groups, never remove anything here.
    if (/\b(duplicate|duplicates|identical files|same file twice)\b/i.test(question)) {
      const { groups, reclaimableBytes } = await buildDuplicateSuggestions(userId);
      return {
        answer: groups.length
          ? `I found ${groups.length} group${groups.length === 1 ? '' : 's'} of identical files (${formatBytes(reclaimableBytes)} could be freed). Review them below. Nothing is removed until you confirm.`
          : "I didn't find any identical files among your files.",
        provider: 'local-rules',
        panel: groups.length ? 'duplicates' : undefined,
        fileId: null,
        timestamp: new Date(),
      };
    }

    // Organizing is always a proposal the user reviews; the panel fetches and applies suggestions.
    if (/\b(organi[sz]e|tidy( up)?|clean up my (files|drive)|sort (out )?my files)\b/i.test(question) && !/\b(move|rename)\b/i.test(question)) {
      return {
        answer: "I'll suggest changes for My Files. Review each one, keep the ones you want, and nothing changes until you confirm.",
        provider: 'local-rules',
        panel: 'organize',
        fileId: null,
        timestamp: new Date(),
      };
    }

    // Plain "find…" questions are answered straight from local search. This needs no model,
    // so it keeps working when Ollama is offline, and it never invents files.
    if (this.questionIsPlainFind(question)) {
      const files = await this.searchForQuestion(userId, question);
      return {
        answer: this.findAnswer(question, files),
        provider: 'local-search',
        files,
        fileId: null,
        timestamp: new Date(),
      };
    }

    const status = await this.getStatus();
    if (!status.reachable) {
      throw new Error(
        status.error || `Ollama is unavailable. Start Ollama and pull ${config.ollama.assistantModel}.`
      );
    }

    const workspaceSnapshot = await this.buildWorkspaceSnapshot(userId);
    const selectedFile = await this.findReferencedFile(userId, fileId, question);
    const planningDecision = await this.planTurn({
      question,
      history,
      workspaceSnapshot,
      selectedFile,
      context,
    });
    const isActionRequest = this.questionLooksActionable(question)
      && !this.questionIsHowTo(question)
      && !this.questionNeedsSummary(question);

    if (planningDecision.intent === 'clarify') {
      return {
        answer: planningDecision.clarifyingQuestion || 'Tell me which file you want me to work with, or select one from the assistant panel.',
        provider: 'ollama',
        model: config.ollama.assistantModel,
        fileId: selectedFile?._id || null,
        timestamp: new Date(),
      };
    }

    if ((planningDecision.intent === 'summarize' || planningDecision.needsFileContext) && !selectedFile && !this.questionIsSearch(question)) {
      return {
        answer: 'Pick a file first, or mention the file name in your message, and I can explain or summarize it.',
        provider: 'ollama',
        model: config.ollama.assistantModel,
        fileId: null,
        timestamp: new Date(),
      };
    }

    let fileContext = '';
    if (selectedFile && planningDecision.needsFileContext) {
      fileContext = await this.buildFileContext(userId, selectedFile, question);
    }

    let actionResult = null;
    const actionContext = {
      selectedFileId: selectedFile?._id?.toString?.() || fileId || null,
      selectedFile,
    };
    const shouldAct =
      planningDecision.shouldExecuteAction &&
      planningDecision.toolAction !== 'none' &&
      planningDecision.confidence >= 0.68;

    if (shouldAct && CONFIRMATION_REQUIRED_ACTIONS.includes(planningDecision.toolAction)) {
      return this.buildConfirmationRequest(planningDecision.toolAction, question, userId, actionContext);
    }

    if (shouldAct) {
      actionResult = await aiActionExecutor.executeAction(
        {
          type: planningDecision.toolAction,
          confidence: planningDecision.confidence,
        },
        question,
        userId,
        actionContext
      );
      if (actionResult?.success) await logFileBoxAction(userId, planningDecision.toolAction, actionResult.data);
    }

    if (planningDecision.intent === 'action' && planningDecision.toolAction === 'none' && isActionRequest) {
      return {
        answer: this.buildUnsupportedActionAnswer(),
        provider: 'ollama',
        model: config.ollama.assistantModel,
        fileId: selectedFile?._id || fileId || null,
        timestamp: new Date(),
      };
    }

    // Ground "find my..." questions in a real local search instead of the model's guess.
    let foundFiles;
    if (!actionResult && this.questionIsSearch(question)) {
      foundFiles = await this.searchForQuestion(userId, question);
    }
    const searchContext = foundFiles
      ? (foundFiles.length
        ? `Local search results the user can access (only mention these files):\n${foundFiles
          .map((file, index) => `${index + 1}. ${file.name} (${file.mimeType}, ${file.source === 'owned' ? 'owned by the user' : file.source === 'team' ? `Team Space file` : `shared by ${file.ownerName || 'someone'}`}, ${file.folder})`)
          .join('\n')}`
        : 'Local search found no matching files in the user\'s drive. Say so plainly and suggest other search words.')
      : '';

    const answer = actionResult
      ? this.formatActionAnswer(planningDecision.toolAction, actionResult)
      : await this.composeAnswer({
          question,
          history,
          workspaceSnapshot,
          selectedFile,
          fileContext,
          actionResult,
          planningDecision,
          context: [context, searchContext].filter(Boolean).join('\n\n'),
        });

    return {
      answer,
      provider: 'ollama',
      model: config.ollama.assistantModel,
      action: actionResult
        ? {
            type: planningDecision.toolAction,
            success: actionResult.success,
            data: actionResult.data,
            error: actionResult.success ? undefined : actionResult.message,
          }
        : undefined,
      files: foundFiles,
      fileId: actionResult?.data?.fileId || selectedFile?._id || fileId || null,
      timestamp: new Date(),
    };
  }
}

module.exports = new OllamaWorkspaceAssistant();
