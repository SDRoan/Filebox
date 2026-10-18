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
const intentRouter = require('./intentRouter');
const { understandRequest } = require('./requestUnderstanding');
const { findFiles, rankReadableFiles } = require('./aiFileFinder');
const { noteActivity } = require('./fileProfiler');
const { ensureIndexed, searchPassages } = require('./fileIndex');
const { filterReadable } = require('./permissions');
const { cleanPhrase, phraseWords, resolveFile, resolveFolder, fileById, folderById } = require('./fileResolver');
const { buildDuplicateSuggestions } = require('./duplicateSuggestions');
const { logFileBoxAction } = require('./activityLog');

// Actions that remove or expose files. The assistant describes them and waits for the user to confirm.
const CONFIRMATION_REQUIRED_ACTIONS = ['delete_file', 'share_file'];

const SUMMARY_HINT_REGEX = /(summar(?:ize|y)|what is this|what is in|tell me about this file|explain this file|what does this file say|give me the gist)/i;

// Actions on files the user names. Names are resolved first; several matches always ask.
const FILE_ACTIONS = {
  rename_file: { verb: 'rename' },
  move_file: { verb: 'move' },
  share_file: { verb: 'share' },
  delete_file: { verb: 'move to Trash' },
  star_file: { verb: 'star' },
  restore_file: { verb: 'restore', trashed: true },
};
const FILE_INTENTS = ['summarize', 'explain', 'file_question'];
const MAX_RESOLVED_IDS = 20;

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
  buildUnsupportedActionAnswer() {
    return "I couldn't tell which change you want. I can create folders and files, and rename, move, star, share, trash or restore a file. Try something like \"Move report.pdf into Archive\".";
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

  extractSearchQuery(question = '') {
    const query = question
      .replace(/^(please\s+)?(can you\s+)?(find|search(?:\s+for)?|look\s+for|locate|show\s+me|where\s+is|where's)\s+/i, '')
      .replace(/\b(my|the|a|an|all|files?|documents?|that|which|mentions?|mentioning|about|related\s+to|in\s+my\s+drive|newest|latest|most\s+recent|recent|oldest|biggest|largest)\b/gi, ' ')
      .replace(/[?.!,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return query || question;
  }

  questionAsksForTrash(question = '') {
    return /\b(trash|trashed|deleted|bin)\b/i.test(question);
  }

  // "Which file mentions MongoDB?" is about contents; "Find my resume" is about what the file is.
  questionAsksAboutContent(question = '') {
    return /\b(mention(?:s|ed|ing)?|about|contain(?:s|ed|ing)?|says?|talks?\s+about|refers?\s+to|discuss(?:es|ing)?|includ(?:es|ing)|related\s+to|regarding|inside|in\s+it|text|word|phrase)\b/i.test(question);
  }

  // Search everything the user may read (owned, shared with them, Team Spaces), using the shared permission rules.
  async searchForQuestion(userId, question) {
    const includeTrash = this.questionAsksForTrash(question);
    const query = this.extractSearchQuery(question).replace(/\b(in\s+)?(the\s+)?(trash|trashed|deleted|bin)\b/gi, ' ').replace(/\s+/g, ' ').trim() || question;
    const preferNames = !this.questionAsksAboutContent(question);
    const { files: found, stats } = await searchWorkspace(userId, query, { limit: 8, scope: 'accessible', includeTrash, preferNames });
    return { files: found.map(file => this.searchItem(file)), hiddenContentMatches: stats.hiddenContentMatches || 0 };
  }

  /**
   * Search when File Box AI is running. The model already said what is wanted: a file that mentions some
   * words is a literal text search; a file that IS something ("my resume") is judged by the model among
   * the files the user may read.
   */
  async aiSearchFiles(userId, route, question) {
    const query = route.searchTerms || route.target || this.extractSearchQuery(question);
    const includeTrash = this.questionAsksForTrash(question);
    if (route.lookFor === 'words_inside_files') {
      const { files } = await searchWorkspace(userId, query, { limit: 8, scope: 'accessible', includeTrash });
      return { files: files.map(file => this.searchItem(file)), query };
    }
    // Files named with the search words are always shown; the model adds files it recognises
    // ("SR profile.txt" for "resume") and leaves out files that only mention the words.
    const named = await this.literalNameMatches(userId, query, includeTrash);
    const found = await findFiles(userId, query, { level: 'viewer' });
    const trashed = includeTrash ? (await findFiles(userId, query, { level: 'owner', trashed: true })).files : [];
    const seen = new Set();
    const files = [...named, ...found.files, ...trashed].filter(file => (seen.has(file._id.toString()) ? false : seen.add(file._id.toString())));
    return { files: (await this.annotateFiles(userId, files)).slice(0, 8), query };
  }

  /** Files whose name has the search words (or some of them, with the rest in the text). */
  async literalNameMatches(userId, query, includeTrash) {
    const words = phraseWords(query).map(word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
    if (!words.length) return [];
    const { files } = await searchWorkspace(userId, query, { limit: 20, scope: 'accessible', includeTrash });
    const texts = new Map((await FileContent.find({ file: { $in: files.map(f => f._id) } }).select('file extractedText').lean())
      .map(c => [c.file.toString(), (c.extractedText || '').toLowerCase()]));
    const ids = files.filter((file) => {
      const name = (file.originalName || '').toLowerCase().replace(/[_\-.]+/g, ' ');
      const inName = words.filter(word => name.includes(word));
      if (inName.length === words.length) return true;
      const text = texts.get(file._id.toString()) || '';
      // No text to check (not extracted, or an image): the name match stands.
      return inName.length > 0 && (!text || words.every(word => name.includes(word) || text.includes(word)));
    }).map(file => file._id);
    return ids.length ? File.find({ _id: { $in: ids } }) : [];
  }

  /** Label files for the results list exactly like local search does (who can see it, and where it is). */
  async annotateFiles(userId, files) {
    if (!files.length) return [];
    await File.populate(files, { path: 'owner', select: 'name email' });
    const readable = await filterReadable(files, userId);
    const parentIds = [...new Set(readable.map(({ file }) => file.parentFolder?.toString()).filter(Boolean))];
    const parentNames = new Map((await Folder.find({ _id: { $in: parentIds } }).select('name').lean()).map(f => [f._id.toString(), f.name]));
    return readable.map(({ file, access }) => this.searchItem({
      ...file.toObject(),
      folderName: file.parentFolder ? parentNames.get(file.parentFolder.toString()) || null : null,
      access,
    }));
  }

  /** Add what File Box read each file to be ("electricity bill", "calculus homework") to result items. */
  async withKinds(items) {
    if (!items?.length) return items;
    const kinds = new Map((await FileContent.find({ file: { $in: items.map(item => item.id) } }).select('file aiType').lean())
      .map(c => [c.file.toString(), c.aiType]));
    return items.map(item => (kinds.get(item.id) ? { ...item, kind: kinds.get(item.id) } : item));
  }

  searchItem(file) {
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
  }

  findAnswer(question, files, hiddenContentMatches = 0, query = this.extractSearchQuery(question)) {
    if (!files.length) {
      return `I couldn't find any files matching "${query}" in your files, files shared with you, or your Team Spaces.`;
    }
    const counts = ['owned', 'shared', 'team']
      .map(source => [source, files.filter(f => f.source === source && !f.trashed).length])
      .filter(([, n]) => n);
    const labels = { owned: 'yours', shared: 'shared with you', team: 'in Team Spaces' };
    const breakdown = counts.map(([source, n]) => `${n} ${labels[source]}`).join(', ');
    const trashed = files.filter(f => f.trashed).length;
    const matching = hiddenContentMatches ? (files.length === 1 ? 'whose name matches' : 'whose names match') : 'matching';
    const hint = hiddenContentMatches
      ? ` ${hiddenContentMatches} other file${hiddenContentMatches === 1 ? ' mentions' : 's mention'} "${query}" in ${hiddenContentMatches === 1 ? 'its' : 'their'} text. Ask "Which files mention ${query}?" to see ${hiddenContentMatches === 1 ? 'it' : 'them'}.`
      : '';
    return `I found ${files.length} file${files.length === 1 ? '' : 's'} ${matching} "${query}"${breakdown ? ` (${breakdown}${trashed ? `, ${trashed} in Trash` : ''})` : trashed ? ' in Trash' : ''}. Select one to open it, or ask me about it.${hint}`;
  }

  questionNeedsSummary(question = '') {
    return SUMMARY_HINT_REGEX.test(question);
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
    const cachedOrGeneratedSummary = this.questionNeedsSummary(question)
      ? await this.summarizeDocument(file, fileContent)
      : (fileContent.summary?.trim() || '');

    const sections = [
      `Selected file: ${file.originalName}`,
      `Type: ${file.mimeType}`,
      `Size: ${formatBytes(file.size)}`,
    ];
    if (fileContent?.aiType) {
      sections.push(`What File Box read this file to be: ${[fileContent.aiCategory, fileContent.aiType].filter(Boolean).join(', ')}. ${fileContent.aiDescription || ''}`);
    }
    if (fileContent?.aiFacts?.length) {
      sections.push(`Key facts noted from the file:\n${fileContent.aiFacts.map(f => `- ${f.label}: ${f.value}`).join('\n')}`);
    }

    if (cachedOrGeneratedSummary) {
      sections.push(`Summary:\n${cachedOrGeneratedSummary}`);
    }

    if (extractedText) {
      sections.push(await this.relevantText(file, extractedText, question));
    }

    const memoryContext = this.formatMemoryContext(memory);
    if (memoryContext) {
      sections.push(`File memory:\n${memoryContext}`);
    }

    return sections.join('\n\n');
  }

  /**
   * The parts of a file that matter for a question: the whole text when it is short, otherwise its
   * beginning plus the passages closest in meaning to the question.
   */
  async relevantText(file, extractedText, question) {
    const limit = config.ollama.assistantMaxFileContextChars;
    if (extractedText.length <= limit) return `Text:\n${extractedText}`;
    try {
      await ensureIndexed([file._id], { limit: 1 });
      const passages = await searchPassages([file._id], question, { k: 6, perFile: 6 });
      if (passages.length) {
        const ordered = [...passages].sort((a, b) => a.index - b.index);
        return `Beginning of the file:\n${extractedText.slice(0, 1500)}\n\nParts of the file most related to the question:\n${ordered.map(p => `[part ${p.index + 1}] ${p.text}`).join('\n\n')}`;
      }
    } catch (error) {
      console.error('[File Box AI] Passage search failed, using the beginning of the file:', error.message);
    }
    return `Excerpt:\n${truncateText(extractedText, limit)}`;
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

  async composeAnswer({
    question,
    history,
    workspaceSnapshot,
    selectedFile,
    fileContext,
    route,
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

    const response = await ollamaClient.chatText({
      model: config.ollama.assistantModel,
      system: `You are File Box Copilot, an Ollama-powered assistant inside a cloud storage website.

Behave like ChatGPT for this product:
- answer naturally and clearly
- stay grounded in the user's actual workspace context
- help with storage, sharing, file understanding, and website actions
- act like an AI version of the user across the available website features
- you are only answering; no action was run, so never claim you changed, moved, shared or deleted anything
- only give steps for explicit how-to questions
- for direct commands, do the action when available instead of describing manual clicks
- never tell the user how to click around the UI for an action the website assistant can perform
- when summarizing a file, explain what it is about and the main points in plain English

Keep answers concise but useful. Prefer short paragraphs. Use bullets only when they help.`,
      content: `Request type: ${route.intent === 'help' ? 'how File Box works' : route.intent === 'file_question' || route.intent === 'explain' ? 'a question about the selected file' : 'general'}

Workspace snapshot:
${workspaceSummary}

${context ? `Additional UI context:\n${context}\n` : ''}

${selectedFile ? `Selected file metadata:\nName: ${selectedFile.originalName}\nType: ${selectedFile.mimeType}\nSize: ${formatBytes(selectedFile.size)}\n` : ''}
{{CONTEXT}}

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

  // ---------- Replies

  routeMeta(route) {
    return {
      intent: route.intent,
      action: route.action || undefined,
      source: route.source,
      rule: route.rule,
      confidence: route.confidence,
      mode: route.mode,
    };
  }

  reply(route, fields) {
    return {
      provider: 'local-rules',
      fileId: null,
      timestamp: new Date(),
      ...fields,
      route: this.routeMeta(route),
    };
  }

  async requireModel() {
    const status = await this.getStatus();
    if (!status.reachable) {
      throw new Error(status.error || `Ollama is unavailable. Start Ollama and pull ${config.ollama.assistantModel}.`);
    }
  }

  /** Several matches: list them and ask. The reply carries what the browser sends back with the choice. */
  choiceReply(route, { resolution, slot, verb, question, fileId, resolved }) {
    const { choices, more, phrase } = resolution;
    const noun = slot === 'folder' ? 'folders' : 'files';
    const allNamed = choices.every(choice => cleanPhrase(choice.name).toLowerCase().replace(/\.[a-z0-9]{1,6}$/i, '') === phrase.toLowerCase().replace(/\.[a-z0-9]{1,6}$/i, ''));
    const total = choices.length + (more || 0);
    let ask = 'Which one do you mean?';
    if (slot === 'folder') ask = 'Which folder should I move it into?';
    else if (verb) ask = `Which one should I ${verb}?`;
    return this.reply(route, {
      answer: `I found ${total} ${noun} ${allNamed ? 'named' : 'matching'} "${phrase}". ${ask}${more ? ` (Showing ${choices.length}. Add more of the name to narrow it down.)` : ''}`,
      choices: { slot, key: phrase.toLowerCase(), options: choices },
      // The interpretation travels with the choice, so picking continues exactly what was understood.
      resume: { question, fileId: fileId || null, resolved: { ...resolved, route: this.portableRoute(route) } },
    });
  }

  portableRoute(route) {
    const { intent, action, target, destination, newName, searchTerms, lookFor, source, rule, confidence, mode } = route;
    return { intent, action, target, destination, newName, searchTerms, lookFor, source, rule, confidence, mode };
  }

  noMatchAnswer(resolution, { level, trashed, verb }) {
    const { phrase, otherAccess } = resolution;
    if (trashed) return `I couldn't find "${phrase}" in your Trash.`;
    if (otherAccess) {
      return `I couldn't find a file of yours matching "${phrase}". "${otherAccess.name}" (${otherAccess.location}) matches, but only its owner can ${verb || 'change'} it.`;
    }
    if (level === 'viewer') return `I couldn't find a file matching "${phrase}" in your files, files shared with you, or your Team Spaces.`;
    return `I couldn't find a file of yours matching "${phrase}".`;
  }

  /**
   * The files a request names, each resolved to exactly one permitted file.
   * Returns { files } or { reply } (a question back to the user).
   */
  async resolveTargets(route, question, userId, { fileId, resolved = {}, level, trashed = false, verb }) {
    const source = route.target || (FILE_INTENTS.includes(route.intent) ? route.normalized : '');
    let explicit = aiActionExecutor.extractFileNames(source || '') || [];
    if (explicit.length && route.intent === 'action' && route.action !== 'rename_file') {
      // "Trash a.txt and b.txt": every file name in the request, except a destination folder's name.
      const notTargets = `${route.destination || ''} ${route.newName || ''}`.toLowerCase();
      const all = (aiActionExecutor.extractFileNames(route.normalized || question) || []).filter(name => !notTargets.includes(name.toLowerCase()));
      if (all.length > explicit.length) explicit = all;
    }
    const phrases = explicit.length ? explicit : [route.target || ''];
    const files = [];

    for (const phrase of phrases) {
      const key = cleanPhrase(phrase).toLowerCase();
      const chosenId = resolved.files?.[key];
      if (chosenId) {
        const file = await fileById(userId, chosenId, { level, trashed });
        if (!file) return { reply: this.reply(route, { answer: "That file isn't available to you anymore. Ask again and I'll look it up." }) };
        files.push(file);
        continue;
      }

      // "this", "it", "this PDF" or nothing at all: the file selected in the panel.
      if (!key || intentRouter.SELF_REFERENCE.test(phrase.trim())) {
        if (fileId) {
          const file = await fileById(userId, fileId, { level, trashed });
          if (file) {
            files.push(file);
            continue;
          }
          return { reply: this.reply(route, { answer: level === 'owner' ? `Only the file's owner can ${verb || 'change'} it.` : "I can't open the selected file." }) };
        }
        return { reply: this.reply(route, { answer: verb ? `Which file should I ${verb}? Mention its name or select it first.` : 'Which file do you mean? Mention its name or select it first.' }) };
      }

      // A typed file name ("budget.pdf") means that file: matched by name, never inferred.
      const byName = route.mode === 'offline' || /\.[a-z0-9]{1,6}$/i.test(phrase.trim());
      const resolution = byName
        ? await resolveFile(userId, phrase, { level, trashed })
        : await this.findWithAI(userId, phrase, { level, trashed });
      if (resolution.status === 'one') {
        // A change the model inferred ("rename my resume" -> "SR profile.txt") is checked with the user first,
        // unless the name plainly matches. Trash and share confirm with the file name anyway.
        if (resolution.inferred && level === 'owner' && !CONFIRMATION_REQUIRED_ACTIONS.includes(route.action) && !resolution.nameMatches) {
          return { reply: this.confirmChoiceReply(route, { resolution, verb, question, fileId, resolved }) };
        }
        files.push(resolution.file);
      } else if (resolution.status === 'many') {
        return { reply: this.choiceReply(route, { resolution, slot: 'file', verb, question, fileId, resolved }) };
      } else {
        return { reply: this.reply(route, { answer: this.noMatchAnswer(resolution, { level, trashed, verb }) }) };
      }
    }
    return { files };
  }

  async findWithAI(userId, phrase, options) {
    let found;
    try {
      found = await findFiles(userId, phrase, options);
    } catch (error) {
      // The model did not answer in time: fall back to plain name matching rather than failing.
      console.error('[File Box AI] File finder failed, using name matching:', error.message);
      return resolveFile(userId, phrase, options);
    }
    const words = phraseWords(phrase);
    const name = (found.files[0]?.originalName || '').toLowerCase().replace(/[_\-.]+/g, ' ');
    return {
      ...found,
      file: found.files[0],
      inferred: true,
      nameMatches: words.length > 0 && words.every(word => name.includes(word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)),
    };
  }

  /** One inferred match for a change: show it and let the user confirm by picking it. */
  confirmChoiceReply(route, { resolution, verb, question, fileId, resolved }) {
    const [choice] = resolution.choices;
    return this.reply(route, {
      answer: `I think you mean "${choice.name}" (${choice.location}). Is that the one you want me to ${verb}? Select it to continue.`,
      choices: { slot: 'file', key: resolution.phrase.toLowerCase(), options: [choice] },
      resume: { question, fileId: fileId || null, resolved: { ...resolved, route: this.portableRoute(route) } },
    });
  }

  /** Destination folder for a move. Returns { folder } or { reply }. */
  async resolveDestination(route, question, userId, { fileId, resolved = {} }) {
    if (resolved.folder) {
      const folder = await folderById(userId, resolved.folder);
      if (!folder) return { reply: this.reply(route, { answer: "That folder isn't available anymore. Ask again and I'll look it up." }) };
      return { folder };
    }
    if (!route.destination) {
      return { reply: this.reply(route, { answer: "Which folder should I move it into? For example \"Move report.pdf into Archive\"." }) };
    }
    const resolution = await resolveFolder(userId, route.destination);
    if (resolution.status === 'one') return { folder: resolution.folder };
    if (resolution.status === 'many') return { reply: this.choiceReply(route, { resolution, slot: 'folder', question, fileId, resolved }) };
    return { reply: this.reply(route, { answer: `I couldn't find a folder of yours named "${resolution.phrase}".` }) };
  }

  // ---------- Intents

  buildConfirmationRequest(route, actionType, question, files) {
    const targets = files.map((file) => file.originalName);
    const fileIds = files.map((file) => file._id.toString());
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

    return this.reply(route, {
      answer,
      provider: 'ollama',
      model: config.ollama.assistantModel,
      fileId: fileIds[0],
      pendingAction: { type: actionType, question, fileId: fileIds[0], fileIds, targets },
    });
  }

  async handleAction(route, { userId, question, fileId, resolved }) {
    const type = route.action;
    if (!type) {
      // The model said "do something" but no rule knows what: ask rather than guess an action.
      return this.reply(route, { answer: this.buildUnsupportedActionAnswer() });
    }

    if (type === 'share_file') {
      // "Share X with Sarah" without an email: ask for it; never fall back to a public link.
      const recipientQuestion = aiActionExecutor.shareRecipientQuestion(question);
      if (recipientQuestion) return this.reply(route, { answer: recipientQuestion, needsInput: 'email' });
    }

    const context = { selectedFileId: null, selectedFile: null, newName: route.newName };
    if (FILE_ACTIONS[type]) {
      const { verb, trashed } = FILE_ACTIONS[type];
      const targets = await this.resolveTargets(route, question, userId, { fileId, resolved, level: 'owner', trashed, verb });
      if (targets.reply) return targets.reply;
      if (type === 'rename_file' && targets.files.length > 1) {
        return this.reply(route, { answer: 'I can rename one file at a time. Which file should I rename first?' });
      }
      context.targetFiles = targets.files;

      if (type === 'move_file') {
        const destination = await this.resolveDestination(route, question, userId, { fileId, resolved });
        if (destination.reply) return destination.reply;
        context.targetFolder = destination.folder;
      }

      if (CONFIRMATION_REQUIRED_ACTIONS.includes(type)) {
        return this.buildConfirmationRequest(route, type, question, targets.files);
      }
    } else if (fileId) {
      const selected = await fileById(userId, fileId, { level: 'owner' });
      context.selectedFileId = selected?._id?.toString() || null;
      context.selectedFile = selected;
    }

    const actionResult = await aiActionExecutor.executeAction({ type, confidence: route.confidence }, question, userId, context);
    if (actionResult?.success) await logFileBoxAction(userId, type, actionResult.data);

    return this.reply(route, {
      answer: this.formatActionAnswer(type, actionResult),
      action: {
        type,
        success: actionResult.success,
        data: actionResult.data,
        error: actionResult.success ? undefined : actionResult.message,
      },
      fileId: actionResult?.data?.fileId || actionResult?.data?.fileIds?.[0] || null,
    });
  }

  async handleFileRequest(route, { userId, question, fileId, resolved, history, context }) {
    const verb = { summarize: 'summarize', explain: 'explain' }[route.intent];
    const targets = await this.resolveTargets(route, question, userId, { fileId, resolved, level: 'viewer', verb });
    if (targets.reply) return targets.reply;
    if (targets.files.length > 1) {
      return this.reply(route, { answer: 'I can work with one file at a time. Ask about each file separately.' });
    }
    const [file] = targets.files;
    await this.requireModel();

    // Summaries and explanations use the same fixed prompts as the file menu.
    const fileAIActions = require('./fileAIActions');
    const candidates = route.intent === 'summarize' ? ['summarize', 'summarize_text']
      : route.intent === 'explain' ? ['explain_code', 'explain_simply'] : [];
    const action = candidates.find(id => fileAIActions.supports(file, id));
    if (action) {
      try {
        const result = await fileAIActions.runAction(file, action);
        return this.reply(route, {
          answer: result.result + (result.truncated ? '\n\n(Only the first part of this long file was read.)' : ''),
          provider: 'ollama',
          model: config.ollama.assistantModel,
          fileId: file._id,
          truncated: Boolean(result.truncated),
        });
      } catch (error) {
        if (error.status && error.status < 500) return this.reply(route, { answer: error.message, fileId: file._id });
        throw error;
      }
    }

    const fileContext = await this.buildFileContext(userId, file, question);
    const answer = await this.composeAnswer({
      question,
      history,
      workspaceSnapshot: await this.buildWorkspaceSnapshot(userId),
      selectedFile: file,
      fileContext,
      route,
      context,
    });
    return this.reply(route, { answer, provider: 'ollama', model: config.ollama.assistantModel, fileId: file._id });
  }

  /**
   * A question answered from what is written in the user's files ("When is my electricity bill due?").
   * Only files the user may read are searched; the answer names the file each fact came from.
   */
  async handleDriveQuestion(route, { userId, question, history }) {
    await this.requireModel();
    const ranked = await rankReadableFiles(userId, question, { limit: 8 });
    const fileIds = ranked.map(r => r.file._id);
    await ensureIndexed(fileIds, { limit: 4 });
    const passages = await searchPassages(fileIds, question, { k: 6, perFile: 3 });

    const byId = new Map(ranked.map(r => [r.file._id.toString(), r.file]));
    const usedIds = [...new Set([...passages.map(p => p.file), ...ranked.slice(0, 3).map(r => r.file._id.toString())])];
    const profiles = new Map((await FileContent.find({ file: { $in: usedIds } }).select('file aiType aiCategory aiDescription aiFacts').lean())
      .map(c => [c.file.toString(), c]));
    const sources = usedIds.map((id, i) => {
      const file = byId.get(id);
      const profile = profiles.get(id) || {};
      const facts = (profile.aiFacts || []).map(f => `${f.label}: ${f.value}`).join('; ');
      const text = passages.filter(p => p.file === id).sort((a, b) => a.index - b.index).map(p => p.text).join('\n...\n');
      return `[${i + 1}] File: ${file.originalName}${profile.aiType ? ` (${[profile.aiCategory, profile.aiType].filter(Boolean).join(', ')})` : ''}`
        + `${profile.aiDescription ? `\nAbout: ${profile.aiDescription}` : ''}${facts ? `\nKey facts: ${facts}` : ''}${text ? `\nText:\n${text}` : ''}`;
    });

    if (!sources.length) {
      return this.reply(route, { answer: "I couldn't find anything in your files that answers that.", provider: 'ollama' });
    }

    const answer = (await ollamaClient.chatText({
      task: 'answer',
      model: config.ollama.assistantModel,
      system: `You answer questions about a person's own files inside File Box, a file storage app.
Use only the file excerpts given. After each fact, name the file it came from in parentheses, for example (electric-bill-oct.pdf).
If the excerpts do not contain the answer, say you couldn't find it in their files and suggest what to upload or search for. Never guess or use outside knowledge for facts about the person.
Be brief and direct.`,
      content: `Recent conversation:\n${this.serializeConversation(history) || 'None.'}\n\nExcerpts from the person's files:\n{{CONTEXT}}\n\nQuestion: ${question}`,
      context: sources.join('\n\n'),
    })).trim();

    // Show the files the answer names (or the most relevant ones when it names none).
    const named = usedIds.filter(id => answer.toLowerCase().includes(byId.get(id).originalName.toLowerCase()));
    const shown = (named.length ? named : usedIds.slice(0, 3)).map(id => byId.get(id));
    const couldNotFind = /couldn['’]?t find|could not find|no information|not (?:mentioned|found)/i.test(answer) && !named.length;
    return this.reply(route, {
      answer,
      provider: 'ollama',
      model: config.ollama.assistantModel,
      files: couldNotFind ? [] : await this.withKinds(await this.annotateFiles(userId, shown)),
    });
  }

  async handleSearch(route, { userId, question }) {
    let found;
    if (route.mode !== 'offline') {
      try {
        found = await this.aiSearchFiles(userId, route, question);
      } catch (error) {
        console.error('[File Box AI] AI search failed, using basic search:', error.message);
      }
    }
    if (!found) found = await this.searchForQuestion(userId, question);
    let { files } = found;
    if (/\b(newest|latest|most\s+recent)\b/i.test(question)) files = [...files].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    else if (/\boldest\b/i.test(question)) files = [...files].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
    return this.reply(route, { answer: this.findAnswer(question, files, found.hiddenContentMatches, found.query), provider: 'local-search', files: await this.withKinds(files) });
  }

  /**
   * Run an action the user explicitly confirmed. Every file is re-checked as owner; nothing is guessed.
   */
  async confirmAction({ userId, type, question, fileId, fileIds }) {
    if (!CONFIRMATION_REQUIRED_ACTIONS.includes(type)) {
      throw new Error('This action does not need confirmation.');
    }
    const failed = (message) => ({
      answer: message,
      provider: 'local-rules',
      action: { type, success: false, error: message },
      fileId: null,
      timestamp: new Date(),
    });

    const ids = (Array.isArray(fileIds) && fileIds.length ? fileIds : [fileId]).filter(id => typeof id === 'string' && id).slice(0, MAX_RESOLVED_IDS);
    let targetFiles = [];
    if (ids.length) {
      for (const id of ids) {
        const file = await fileById(userId, id, { level: 'owner' });
        if (!file) return failed("I couldn't do that: the file isn't available, or only its owner can do this.");
        targetFiles.push(file);
      }
    } else {
      // No file chosen: re-read the request by rules only, and act only when every name matches one file.
      const route = { ...intentRouter.routeIntent(question), mode: 'offline' };
      if (route.action !== type) return failed('Ask again so I can check which file you mean.');
      const targets = await this.resolveTargets(route, question, userId, { level: 'owner', verb: FILE_ACTIONS[type].verb });
      if (targets.reply) return failed(targets.reply.answer);
      targetFiles = targets.files;
    }

    const actionResult = await aiActionExecutor.executeAction({ type, confidence: 1 }, question, userId, { targetFiles });
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
      fileId: targetFiles[0]?._id || null,
      timestamp: new Date(),
    };
  }

  /**
   * What the user wants. The local model reads the request (with recent conversation); when Ollama is not
   * running, simple rules stand in and the reply is marked offline. A choice from an earlier list carries
   * the original interpretation, so it is not re-read.
   */
  async understand({ question, fileId, history, resolved }) {
    noteActivity();
    if (resolved.route) return resolved.route;
    const hasSelectedFile = Boolean(fileId);
    const status = await this.getStatus();
    if (status.reachable) {
      try {
        return { ...(await understandRequest(question, { hasSelectedFile, history })), mode: 'ai' };
      } catch (error) {
        console.error('[File Box AI] Understanding failed, using offline rules:', error.message);
      }
    }
    const fileNames = aiActionExecutor.extractFileNames(question) || [];
    return { ...intentRouter.routeIntent(question, { hasSelectedFile, fileNames }), mode: 'offline' };
  }

  /**
   * One chat turn: understand the request, resolve the files it names among those the user may access
   * (asking when several match), then search, act (with the usual confirmations) or answer.
   *
   * `resolved` carries choices the user made from an earlier list: { files: { "<name>": id }, folder: id }.
   */
  async chat({ userId, question, fileId, history = [], context = '', resolved = {} }) {
    const route = await this.understand({ question, fileId, history, resolved });
    const turn = { userId, question, fileId, history, context, resolved };

    switch (route.intent) {
      case 'duplicates': {
        // Duplicate cleanup is rule-based and review-only: show the groups, never remove anything here.
        const { groups, reclaimableBytes } = await buildDuplicateSuggestions(userId);
        return this.reply(route, {
          answer: groups.length
            ? `I found ${groups.length} group${groups.length === 1 ? '' : 's'} of identical files (${formatBytes(reclaimableBytes)} could be freed). Review them below. Nothing is removed until you confirm.`
            : "I didn't find any identical files among your files.",
          panel: groups.length ? 'duplicates' : undefined,
        });
      }
      case 'organize':
        // Organizing is always a proposal the user reviews; the panel fetches and applies suggestions.
        return this.reply(route, {
          answer: "I'll suggest changes for My Files. Review each one, keep the ones you want, and nothing changes until you confirm.",
          panel: 'organize',
        });
      case 'search':
      case 'smart_search':
        // Answered from local search: needs no model, works offline, never invents files.
        return this.handleSearch(route, turn);
      case 'action':
        return this.handleAction(route, turn);
      case 'summarize':
      case 'explain':
      case 'file_question':
        return this.handleFileRequest(route, turn);
      case 'drive_question':
        return this.handleDriveQuestion(route, turn);
      default: {
        await this.requireModel();
        const answer = await this.composeAnswer({
          question,
          history,
          workspaceSnapshot: await this.buildWorkspaceSnapshot(userId),
          selectedFile: null,
          fileContext: '',
          route,
          context,
        });
        return this.reply(route, { answer, provider: 'ollama', model: config.ollama.assistantModel });
      }
    }
  }
}

module.exports = new OllamaWorkspaceAssistant();
