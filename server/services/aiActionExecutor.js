const bcrypt = require('bcryptjs');
const fs = require('fs-extra');
const path = require('path');
const File = require('../models/File');
const Folder = require('../models/Folder');
const FileRelationship = require('../models/FileRelationship');
const FileContent = require('../models/FileContent');
const User = require('../models/User');
const Share = require('../models/Share');
const FileRequest = require('../models/FileRequest');
const WebShortcut = require('../models/WebShortcut');
const SecuredLink = require('../models/SecuredLink');
const Template = require('../models/Template');
const CloudBackup = require('../models/CloudBackup');
const TeamFolder = require('../models/TeamFolder');
const cloudBackupService = require('./cloudBackup');
const {
  buildDocxBufferFromHtml,
  buildPdfBytesFromHtml,
  htmlToPlainText,
} = require('./richDocumentBuilder');

class AIActionExecutor {
  sanitizeLabel(value) {
    if (!value) {
      return '';
    }

    return value
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!,;:]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractQuotedPhrase(message, { allowUrl = false } = {}) {
    const match = message.match(/["'`]([^"'`]+)["'`]/);
    const value = this.sanitizeLabel(match?.[1] || '');

    if (!value) {
      return '';
    }

    if (!allowUrl && /^https?:\/\//i.test(value)) {
      return '';
    }

    return value;
  }

  extractUrl(message) {
    const match = message.match(/https?:\/\/[^\s"'`]+/i);
    return match ? match[0].trim() : '';
  }

  extractEmail(message) {
    const match = message.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return match ? match[0].trim() : '';
  }

  extractNamedValue(message, nounPatterns = []) {
    const quoted = this.extractQuotedPhrase(message);
    if (quoted) {
      return quoted;
    }

    for (const nounPattern of nounPatterns) {
      const match = message.match(nounPattern);
      const value = this.sanitizeLabel(match?.[1] || '');
      if (value) {
        return value;
      }
    }

    return '';
  }

  extractFolderName(message) {
    return this.extractNamedValue(message, [
      /(?:create|make)(?:\s+(?:me|us))?(?:\s+(?:a|an))?\s+folder(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
      /new\s+folder(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
    ]);
  }

  extractTemplateName(message) {
    return this.extractNamedValue(message, [
      /(?:create|make)(?:\s+(?:a|an))?\s+template(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
    ]);
  }

  extractFileName(message) {
    const quoted = this.extractQuotedPhrase(message);
    if (quoted) {
      return quoted;
    }

    const match = message.match(
      /(?:create|make)(?:\s+(?:me|us))?(?:\s+(?:a|an))?\s+(?:pdf|docx?|word|text)?\s*file(?:\s+(?:called|named))?\s+([^.\n!?]+)/i
    );

    return this.sanitizeLabel(match?.[1] || '');
  }

  detectRequestedFileType(message = '') {
    if (/\bpdf\b/i.test(message)) {
      return {
        kind: 'pdf',
        extension: '.pdf',
        mimeType: 'application/pdf',
      };
    }

    if (/\b(docx|word|document)\b/i.test(message)) {
      return {
        kind: 'docx',
        extension: '.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    }

    if (/\b(txt|text file|plain text|note)\b/i.test(message)) {
      return {
        kind: 'txt',
        extension: '.txt',
        mimeType: 'text/plain',
      };
    }

    return {
      kind: 'docx',
      extension: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }

  extractFileRequestTitle(message) {
    return this.extractNamedValue(message, [
      /(?:create|make)(?:\s+(?:a|an))?\s+file\s+request(?:\s+(?:called|named|for))?\s+([^.\n!?]+)/i,
    ]);
  }

  extractShortcutTitle(message) {
    return this.extractNamedValue(message, [
      /(?:create|add|make)(?:\s+(?:a|an))?\s+(?:shortcut|link)(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
    ]);
  }

  extractSecuredLinkTitle(message) {
    return this.extractNamedValue(message, [
      /(?:create|add|make)(?:\s+(?:a|an))?\s+secured\s+link(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
      /(?:create|add|make)(?:\s+(?:a|an))?\s+secure\s+link(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
    ]);
  }

  extractTeamFolderName(message) {
    return this.extractNamedValue(message, [
      /(?:create|make)(?:\s+(?:a|an))?\s+(?:team\s+(?:folder|space)|teamspace)(?:\s+(?:called|named))?\s+([^.\n!?]+)/i,
    ]);
  }

  parseNaturalDate(rawValue) {
    const raw = this.sanitizeLabel(rawValue);
    if (!raw) {
      return null;
    }

    const lower = raw.toLowerCase();
    const now = new Date();
    const date = new Date(now);
    date.setSeconds(0, 0);

    const applyTime = (target, timeText) => {
      const match = timeText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (!match) {
        return target;
      }

      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2] || '0', 10);
      const meridiem = (match[3] || '').toLowerCase();

      if (meridiem === 'pm' && hours < 12) {
        hours += 12;
      }
      if (meridiem === 'am' && hours === 12) {
        hours = 0;
      }

      target.setHours(hours, minutes, 0, 0);
      return target;
    };

    const relativeMatch = lower.match(/^(today|tomorrow|next week|next month)(?:\s+at\s+(.+))?$/i);
    if (relativeMatch) {
      switch (relativeMatch[1].toLowerCase()) {
        case 'tomorrow':
          date.setDate(date.getDate() + 1);
          break;
        case 'next week':
          date.setDate(date.getDate() + 7);
          break;
        case 'next month':
          date.setMonth(date.getMonth() + 1);
          break;
        default:
          break;
      }

      if (relativeMatch[2]) {
        return applyTime(date, relativeMatch[2]);
      }

      return date;
    }

    const monthNames = {
      january: 0,
      february: 1,
      march: 2,
      april: 3,
      may: 4,
      june: 5,
      july: 6,
      august: 7,
      september: 8,
      october: 9,
      november: 10,
      december: 11,
    };

    const monthDayMatch = raw.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+at\s+(.+))?$/i);
    if (monthDayMatch) {
      const monthIndex = monthNames[monthDayMatch[1].toLowerCase()];
      if (monthIndex !== undefined) {
        const fallbackDate = new Date(
          parseInt(monthDayMatch[3] || `${now.getFullYear()}`, 10),
          monthIndex,
          parseInt(monthDayMatch[2], 10),
          9,
          0,
          0,
          0
        );

        if (monthDayMatch[4]) {
          return applyTime(fallbackDate, monthDayMatch[4]);
        }

        return fallbackDate;
      }
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }

    if (!/\b20\d{2}\b/.test(raw)) {
      const withCurrentYear = new Date(`${raw}, ${now.getFullYear()}`);
      if (!Number.isNaN(withCurrentYear.getTime())) {
        return withCurrentYear;
      }
    }

    return null;
  }

  extractDateAfterKeyword(message, keywords) {
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b\\s+(.+?)(?:\\s+(?:for|in|with|called|named|priority|max|tagged)\\b|[.!?]|$)`, 'i');
      const match = message.match(regex);
      const date = this.parseNaturalDate(match?.[1] || '');
      if (date) {
        return date;
      }
    }

    return null;
  }

  extractDescription(message) {
    const match = message.match(/\bdescription\s+(.+?)(?:[.!?]|$)/i);
    return this.sanitizeLabel(match?.[1] || '');
  }

  extractTags(message) {
    const match = message.match(/\btags?\s+(.+?)(?:[.!?]|$)/i);
    if (!match?.[1]) {
      return [];
    }

    return match[1]
      .split(/[,\s]+/)
      .map((tag) => this.sanitizeLabel(tag.replace(/^#/, '')))
      .filter(Boolean);
  }

  extractPassword(message) {
    const match = message.match(/\bpassword(?:\s+(?:is|as))?\s+["'`]([^"'`]+)["'`]/i)
      || message.match(/\bpassword(?:\s+(?:is|as))?\s+([^\s.,!?]+)/i);
    return this.sanitizeLabel(match?.[1] || '');
  }

  getSelectedFileId(context = {}) {
    return context?.selectedFileId || context?.selectedFile?._id || null;
  }

  async getSelectedOwnedFiles(context = {}, userId) {
    const selectedFileId = this.getSelectedFileId(context);
    if (!selectedFileId) {
      return [];
    }

    const file = await File.findOne({
      _id: selectedFileId,
      owner: userId,
      isTrashed: { $ne: true },
    });

    return file ? [file] : [];
  }

  async findFolderByName(folderName, userId) {
    if (!folderName) {
      return null;
    }

    let folder = await Folder.findOne({
      owner: userId,
      name: folderName,
      isTrashed: { $ne: true },
    });

    if (!folder) {
      const escapedName = folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      folder = await Folder.findOne({
        owner: userId,
        name: { $regex: escapedName, $options: 'i' },
        isTrashed: { $ne: true },
      });
    }

    return folder;
  }

  async resolveFilesFromMessageOrSelection(message, userId, context = {}) {
    const fileNames = this.extractFileNames(message);
    if (fileNames?.length) {
      return this.findFilesByName(fileNames, userId);
    }

    return this.getSelectedOwnedFiles(context, userId);
  }

  /**
   * Parse user message to detect action intent.
   */
  parseAction(message) {
    const lowerMessage = message.toLowerCase();

    const match = (pattern) => pattern.test(message);
    const mentionsFile = /(file|document|this)/i.test(message) || Boolean(this.extractFileNames(message));

    if (match(/create.*(?:team\s+(?:folder|space)|teamspace)|make.*(?:team\s+(?:folder|space)|teamspace)|new.*team\s+(?:folder|space)/i)) {
      return { type: 'create_team_folder', confidence: 0.92 };
    }

    if (match(/create.*file request|make.*file request|new.*file request/i)) {
      return { type: 'create_file_request', confidence: 0.9 };
    }

    if (match(/create.*(?:pdf|docx?|word|text)?\s*file|make.*(?:pdf|docx?|word|text)?\s*file|new.*(?:pdf|docx?|word|text)?\s*file/i)) {
      return { type: 'create_file', confidence: 0.92 };
    }

    if (match(/create.*secured link|create.*secure link|add.*secured link|add.*secure link/i)) {
      return { type: 'create_secured_link', confidence: 0.9 };
    }

    if (match(/create.*shortcut|add.*shortcut|save.*shortcut|bookmark.*website/i)) {
      return { type: 'create_shortcut', confidence: 0.88 };
    }

    if (match(/create.*template|make.*template|turn .* into .*template/i)) {
      return { type: 'create_template', confidence: 0.87 };
    }

    if (match(/backup.*desktop|backup.*documents|cloud backup|set up.*backup|create.*backup/i)) {
      return { type: 'create_cloud_backup', confidence: 0.88 };
    }

    if (
      match(/create.*relationship|relate|link|connect.*file|relationship.*between|make.*relationship|add.*relationship/i) ||
      ((this.extractFileNames(message) || []).length >= 2 && /(relationship|relate|link|connect)/i.test(message))
    ) {
      return { type: 'create_relationship', confidence: 0.9 };
    }

    if (match(/delete|remove|trash/i) && mentionsFile) {
      return { type: 'delete_file', confidence: 0.82 };
    }

    if (match(/create.*folder|make.*folder|new.*folder/i)) {
      return { type: 'create_folder', confidence: 0.9 };
    }

    if (match(/share.*file|share.*with|create.*share|share.*link|share this/i)) {
      return { type: 'share_file', confidence: 0.82 };
    }

    if ((/star|favorite|bookmark/i.test(message) && mentionsFile) || /star this/i.test(lowerMessage)) {
      return { type: 'star_file', confidence: 0.8 };
    }

    if ((/move|transfer|put.*in|move.*to/i.test(message) && /(file|document|this|\.)/i.test(message)) || /move this/i.test(lowerMessage)) {
      return { type: 'move_file', confidence: 0.76 };
    }

    if ((/rename|change.*name|call.*file|name.*file/i.test(message) && mentionsFile) || /rename this/i.test(lowerMessage)) {
      return { type: 'rename_file', confidence: 0.84 };
    }

    return null;
  }

  /**
   * Extract file names from message.
   */
  extractFileNames(message) {
    const fileNames = [];
    const filePattern = /([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:pdf|docx?|txt|md|rtf|odt|jpg|jpeg|png|gif|mp4|mp3|zip|rar|pptx?|xlsx?|csv|json|xml|html|css|js|ts|py|java|cpp|c|h|go|rs|rb|php|swift|kt|dart|sh|bat|ps1))/gi;
    let match;
    const seen = new Set();

    while ((match = filePattern.exec(message)) !== null) {
      let fileName = match[1].trim();
      fileName = fileName.replace(/\s+(and|or|create|relationship|relate|link|connect|between|from|to|delete|remove|share|star)\s*$/i, '').trim();
      fileName = fileName.replace(/\s+/g, '');

      if (fileName && fileName.length < 200 && !seen.has(fileName.toLowerCase())) {
        fileNames.push(fileName);
        seen.add(fileName.toLowerCase());
      }
    }

    if (fileNames.length) {
      return fileNames;
    }

    const quotedPattern = /["']([^"']+\.(?:pdf|docx?|txt|md|rtf|odt|jpg|jpeg|png|gif|mp4|mp3|zip|rar|pptx?|xlsx?))["']/gi;
    const quotedMatches = [];
    while ((match = quotedPattern.exec(message)) !== null) {
      quotedMatches.push(match[1].trim());
    }
    if (quotedMatches.length) {
      return [...new Set(quotedMatches)];
    }

    return null;
  }

  /**
   * Find files by name for a user.
   */
  async findFilesByName(fileNames, userId) {
    const files = [];

    for (const fileName of fileNames) {
      const cleanName = fileName.trim();
      let file = await File.findOne({
        owner: userId,
        originalName: cleanName,
        isTrashed: { $ne: true },
      });

      if (!file) {
        const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        file = await File.findOne({
          owner: userId,
          originalName: { $regex: escapedName, $options: 'i' },
          isTrashed: { $ne: true },
        });
      }

      if (!file && cleanName.includes('.')) {
        const baseName = cleanName.split('.')[0];
        const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        file = await File.findOne({
          owner: userId,
          originalName: { $regex: `^${escapedBase}`, $options: 'i' },
          isTrashed: { $ne: true },
        });
      }

      if (file) {
        files.push(file);
      }
    }

    return files;
  }

  async findUserByIdentifier(identifier) {
    if (!identifier) {
      return null;
    }

    let user = await User.findOne({ email: identifier });
    if (!user) {
      user = await User.findOne({
        name: { $regex: `^${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      });
    }

    return user;
  }

  async createRelationship(message, userId) {
    let fileNames = this.extractFileNames(message);

    if (!fileNames || fileNames.length < 2) {
      const allFiles = await File.find({
        owner: userId,
        isTrashed: { $ne: true },
      }).select('originalName');

      const mentionedFiles = allFiles
        .filter((file) => message.toLowerCase().includes(file.originalName.toLowerCase()))
        .map((file) => file.originalName);

      if (mentionedFiles.length >= 2) {
        fileNames = mentionedFiles.slice(0, 2);
      }
    }

    if (!fileNames || fileNames.length < 2) {
      return {
        success: false,
        message: "I need two file names to create a relationship. Try something like 'Create a relationship between file1.pdf and file2.pdf'.",
      };
    }

    const files = await this.findFilesByName(fileNames, userId);
    if (files.length < 2) {
      return {
        success: false,
        message: `I couldn't find both files. Looking for: ${fileNames.join(' and ')}.`,
      };
    }

    let relationshipType = 'related';
    if (/version|v\d+/i.test(message)) relationshipType = 'version_of';
    else if (/depends|dependency/i.test(message)) relationshipType = 'depends_on';
    else if (/references|refers/i.test(message)) relationshipType = 'references';
    else if (/part|contains/i.test(message)) relationshipType = 'part_of';

    const existing = await FileRelationship.findOne({
      sourceFile: files[0]._id,
      targetFile: files[1]._id,
      owner: userId,
    });

    if (existing) {
      return {
        success: false,
        message: `A relationship already exists between "${files[0].originalName}" and "${files[1].originalName}".`,
      };
    }

    const relationship = new FileRelationship({
      sourceFile: files[0]._id,
      targetFile: files[1]._id,
      relationshipType,
      owner: userId,
    });

    await relationship.save();

    return {
      success: true,
      message: `Successfully created a relationship between "${files[0].originalName}" and "${files[1].originalName}".`,
      data: {
        relationshipId: relationship._id,
        sourceFile: files[0].originalName,
        targetFile: files[1].originalName,
        relationshipType,
      },
    };
  }

  async deleteFile(message, userId, context = {}) {
    const files = await this.resolveFilesFromMessageOrSelection(message, userId, context);

    if (!files.length) {
      return {
        success: false,
        message: 'I need a file to delete. Mention the file name or select a file first.',
      };
    }

    const deletedFiles = [];
    for (const file of files) {
      file.isTrashed = true;
      file.deletedAt = new Date();
      await file.save();
      deletedFiles.push(file.originalName);
    }

    return {
      success: true,
      message: `Moved ${deletedFiles.join(', ')} to Trash.`,
      data: { deletedFiles },
    };
  }

  async createFolder(message, userId) {
    const folderName = this.extractFolderName(message);

    if (!folderName) {
      return {
        success: false,
        message: "I need a folder name to create. Try 'Create a folder called My Documents'.",
      };
    }

    const existing = await Folder.findOne({
      name: folderName,
      owner: userId,
      isTrashed: { $ne: true },
    });

    if (existing) {
      return {
        success: false,
        message: `A folder named "${folderName}" already exists.`,
      };
    }

    const folder = new Folder({
      name: folderName,
      owner: userId,
    });

    await folder.save();

    return {
      success: true,
      message: `Successfully created folder "${folderName}".`,
      data: {
        folderId: folder._id,
        folderName: folder.name,
      },
    };
  }

  async starFile(message, userId, context = {}) {
    const files = await this.resolveFilesFromMessageOrSelection(message, userId, context);

    if (!files.length) {
      return {
        success: false,
        message: 'I need a file to star. Mention the file name or select one first.',
      };
    }

    const starredFiles = [];
    for (const file of files) {
      file.isStarred = true;
      await file.save();
      starredFiles.push(file.originalName);
    }

    return {
      success: true,
      message: `Starred ${starredFiles.join(', ')}.`,
      data: { starredFiles },
    };
  }

  async shareFile(message, userId, context = {}) {
    const files = await this.resolveFilesFromMessageOrSelection(message, userId, context);

    if (!files.length) {
      return {
        success: false,
        message: 'I need a file to share. Mention the file name or select one first.',
      };
    }

    const userEmail = this.extractEmail(message);

    if (userEmail) {
      const userToShare = await this.findUserByIdentifier(userEmail);
      if (!userToShare) {
        return {
          success: false,
          message: `User with email ${userEmail} not found.`,
        };
      }

      const sharedFiles = [];
      for (const file of files) {
        const alreadyShared = file.sharedWith.find(
          (entry) => entry.user.toString() === userToShare._id.toString()
        );

        if (!alreadyShared) {
          file.sharedWith.push({
            user: userToShare._id,
            permission: 'view',
          });
          await file.save();
        }

        sharedFiles.push(file.originalName);
      }

      return {
        success: true,
        message: `Shared ${sharedFiles.join(', ')} with ${userEmail}.`,
        data: {
          sharedFiles,
          sharedWith: userEmail,
        },
      };
    }

    const shareLinks = [];
    for (const file of files) {
      const share = new Share({
        file: file._id,
        owner: userId,
        accessType: 'view',
      });
      await share.save();
      shareLinks.push({
        fileName: file.originalName,
        shareId: share.shareId,
      });
    }

    return {
      success: true,
      message: `Created ${shareLinks.length} share link${shareLinks.length > 1 ? 's' : ''}.`,
      data: {
        sharedFiles: shareLinks.map((link) => link.fileName),
        shareLinks,
      },
    };
  }

  async moveFile(message, userId, context = {}) {
    const files = await this.resolveFilesFromMessageOrSelection(message, userId, context);

    if (!files.length) {
      return {
        success: false,
        message: 'I need a file to move. Mention the file name or select one first.',
      };
    }

    const folderMatch = message.match(/(?:to|into|in)\s+["'`]?([^"'`]+?)["'`]?(?:[.!?]|$)/i)
      || message.match(/folder\s+["'`]?([^"'`]+?)["'`]?(?:[.!?]|$)/i);
    const folderName = this.sanitizeLabel(folderMatch?.[1] || '');

    if (!folderName) {
      return {
        success: false,
        message: "Tell me which folder to move the file into, for example 'Move this file to Tax Docs'.",
      };
    }

    const folder = await this.findFolderByName(folderName, userId);
    if (!folder) {
      return {
        success: false,
        message: `Folder "${folderName}" not found.`,
      };
    }

    const movedFiles = [];
    for (const file of files) {
      file.parentFolder = folder._id;
      await file.save();
      movedFiles.push(file.originalName);
    }

    return {
      success: true,
      message: `Moved ${movedFiles.join(', ')} to "${folder.name}".`,
      data: {
        movedFiles,
        targetFolder: folder.name,
      },
    };
  }

  async renameFile(message, userId, context = {}) {
    const files = await this.resolveFilesFromMessageOrSelection(message, userId, context);

    if (!files.length) {
      return {
        success: false,
        message: 'I need a file to rename. Mention the file name or select one first.',
      };
    }

    const newNameMatch = message.match(/(?:to|as|named|call)\s+["'`]?([^"'`]+?)["'`]?(?:[.!?]|$)/i);
    const newName = this.sanitizeLabel(newNameMatch?.[1] || '');

    if (!newName) {
      return {
        success: false,
        message: "I need the new file name, for example 'Rename this file to cleaned-resume.pdf'.",
      };
    }

    const file = files[0];
    const oldName = file.originalName;
    file.originalName = newName;
    await file.save();

    return {
      success: true,
      message: `Renamed "${oldName}" to "${newName}".`,
      data: {
        oldName,
        newName,
      },
    };
  }

  async createFileRequest(message, userId) {
    const title = this.extractFileRequestTitle(message) || 'New file request';
    const description = this.extractDescription(message);
    const expiresAt = this.extractDateAfterKeyword(message, ['expires', 'expire', 'until']);

    const fileRequest = new FileRequest({
      title,
      description,
      requester: userId,
      expiresAt,
    });

    await fileRequest.save();

    return {
      success: true,
      message: `Created the file request "${title}".`,
      data: {
        requestId: fileRequest.requestId,
        title: fileRequest.title,
      },
    };
  }

  async createFile(message, userId) {
    const requestedType = this.detectRequestedFileType(message);
    const requestedName = this.extractFileName(message);

    const baseName = requestedName || `Untitled ${requestedType.kind.toUpperCase()}`;
    const sanitizedBaseName = this.sanitizeLabel(baseName).replace(/\.[a-z0-9]+$/i, '') || `Untitled ${requestedType.kind.toUpperCase()}`;
    const originalName = `${sanitizedBaseName}${requestedType.extension}`;
    const uploadsDir = path.join(__dirname, '..', 'uploads', userId.toString());
    await fs.ensureDir(uploadsDir);

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const storedName = `${uniqueSuffix}${requestedType.extension}`;
    const filePath = path.join(uploadsDir, storedName);
    const starterText = requestedName
      ? `${sanitizedBaseName}\n`
      : '';
    const editorHtml = starterText
      ? `<p>${starterText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
      : '<p></p>';

    let buffer;
    if (requestedType.kind === 'pdf') {
      buffer = await buildPdfBytesFromHtml(editorHtml);
    } else if (requestedType.kind === 'docx') {
      buffer = await buildDocxBufferFromHtml(editorHtml);
    } else {
      buffer = Buffer.from(starterText, 'utf8');
    }

    await fs.writeFile(filePath, buffer);

    const owner = await User.findById(userId);
    if (owner) {
      owner.storageUsed += buffer.length;
      await owner.save();
    }

    const file = new File({
      name: storedName,
      originalName,
      path: filePath,
      size: buffer.length,
      mimeType: requestedType.mimeType,
      owner: userId,
      parentFolder: null,
    });

    await file.save();

    await FileContent.findOneAndUpdate(
      { file: file._id },
      {
        $set: {
          extractedText: htmlToPlainText(editorHtml),
          extractedAt: new Date(),
          extractionMethod: requestedType.kind === 'pdf' ? 'assistant-created-pdf' : requestedType.kind === 'docx' ? 'assistant-created-docx' : 'assistant-created-text',
          extractionStatus: 'completed',
          editorHtml,
          editorUpdatedAt: new Date(),
        },
        $setOnInsert: {
          file: file._id,
        },
      },
      { upsert: true }
    );

    return {
      success: true,
      message: `Created the file "${originalName}".`,
      data: {
        fileId: file._id,
        fileName: file.originalName,
        mimeType: file.mimeType,
      },
    };
  }

  async createWebShortcut(message, userId) {
    const url = this.extractUrl(message);
    if (!url) {
      return {
        success: false,
        message: 'I need the URL to create a shortcut.',
      };
    }

    let title = this.extractShortcutTitle(message);
    if (!title) {
      title = new URL(url).hostname;
    }

    const shortcut = new WebShortcut({
      user: userId,
      title,
      url,
      description: this.extractDescription(message),
      tags: this.extractTags(message),
    });

    await shortcut.save();

    return {
      success: true,
      message: `Created the shortcut "${shortcut.title}".`,
      data: {
        shortcutId: shortcut._id,
        title: shortcut.title,
        url: shortcut.url,
      },
    };
  }

  async createSecuredLink(message, userId) {
    const url = this.extractUrl(message);
    if (!url) {
      return {
        success: false,
        message: 'I need the URL to create a secured link.',
      };
    }

    const title = this.extractSecuredLinkTitle(message) || new URL(url).hostname;
    const password = this.extractPassword(message);
    const isPasswordProtected = /password|protected/i.test(message) || Boolean(password);
    const isEncrypted = /encrypted|encrypt/i.test(message);
    const categoryMatch = message.match(/\bcategory\s+([a-zA-Z-]+)/i);

    const link = new SecuredLink({
      user: userId,
      title,
      url: isEncrypted ? '' : url,
      encryptedUrl: null,
      password: isPasswordProtected && password ? await bcrypt.hash(password, 10) : null,
      passwordHint: '',
      description: this.extractDescription(message),
      category: this.sanitizeLabel(categoryMatch?.[1] || '') || 'general',
      tags: this.extractTags(message),
      isPasswordProtected,
      isEncrypted,
      notes: '',
      expiresAt: this.extractDateAfterKeyword(message, ['expires', 'expire', 'until']),
    });

    if (isEncrypted) {
      link.url = url;
      link.encryptUrl(password || process.env.JWT_SECRET || 'file-box-local-master-key');
    }

    await link.save();

    return {
      success: true,
      message: `Created the secured link "${link.title}".`,
      data: {
        securedLinkId: link._id,
        title: link.title,
      },
    };
  }

  async createTemplate(message, userId, context = {}) {
    const templateName = this.extractTemplateName(message) || 'New template';
    const selectedFileId = this.getSelectedFileId(context);
    const createFromSelectedFile = /from this file|from selected file|use this file|turn this file into/i.test(message) && selectedFileId;

    if (createFromSelectedFile) {
      const file = (await this.getSelectedOwnedFiles(context, userId))[0];
      if (!file) {
        return {
          success: false,
          message: 'I could not access the selected file to turn it into a template.',
        };
      }

      const template = new Template({
        name: templateName || file.originalName,
        description: this.extractDescription(message),
        category: 'other',
        content: '',
        filePath: file.path,
        mimeType: file.mimeType,
        tags: this.extractTags(message),
        isPublic: /public/i.test(message),
        createdBy: userId,
      });

      await template.save();

      return {
        success: true,
        message: `Created the template "${template.name}" from "${file.originalName}".`,
        data: {
          templateId: template._id,
          templateName: template.name,
        },
      };
    }

    const template = new Template({
      name: templateName,
      description: this.extractDescription(message),
      category: 'other',
      content: '',
      tags: this.extractTags(message),
      isPublic: /public/i.test(message),
      createdBy: userId,
    });

    await template.save();

    return {
      success: true,
      message: `Created the template "${template.name}".`,
      data: {
        templateId: template._id,
        templateName: template.name,
      },
    };
  }

  async createTeamFolder(message, userId) {
    const name = this.extractTeamFolderName(message) || 'New team space';

    const teamFolder = new TeamFolder({
      name,
      owner: userId,
      members: [
        {
          user: userId,
          role: 'admin',
          joinedAt: new Date(),
        },
      ],
    });

    await teamFolder.save();

    return {
      success: true,
      message: `Created the team space "${name}".`,
      data: {
        teamFolderId: teamFolder._id,
        teamFolderName: teamFolder.name,
      },
    };
  }

  async createCloudBackup(message, userId) {
    let sourceType = 'documents';
    let sourcePath = '';

    if (/desktop/i.test(message)) {
      sourceType = 'desktop';
      sourcePath = cloudBackupService.getDefaultBackupPaths().desktop || '';
    } else if (/documents/i.test(message)) {
      sourceType = 'documents';
      sourcePath = cloudBackupService.getDefaultBackupPaths().documents || '';
    }

    // Custom folder paths are only accepted from the Backup page, never from chat.
    if (!sourcePath) {
      return {
        success: false,
        message: 'I can set up a Desktop or Documents backup. For any other folder, use the Backup page.',
      };
    }

    const exists = await cloudBackupService.checkPathExists(sourcePath);
    if (!exists) {
      return {
        success: false,
        message: `I can't access "${sourcePath}" from the server right now.`,
      };
    }

    const backupFrequency = /hourly/i.test(message) ? 'hourly' : /weekly/i.test(message) ? 'weekly' : 'daily';
    const backup = await cloudBackupService.createOrUpdateBackup(userId, sourceType, sourcePath, {
      enabled: true,
      backupFrequency,
    });

    return {
      success: true,
      message: `Created the ${sourceType} cloud backup configuration.`,
      data: {
        backupId: backup._id,
        sourceType: backup.sourceType,
        sourcePath: backup.sourcePath,
        backupFrequency: backup.backupFrequency,
      },
    };
  }

  /**
   * Names of the owned files an action would touch, so the assistant can ask for confirmation first.
   */
  async describeTargets(message, userId, context = {}) {
    const files = await this.resolveFilesFromMessageOrSelection(message, userId, context);
    return files.map((file) => file.originalName);
  }

  async executeAction(action, message, userId, context = {}) {
    try {
      switch (action.type) {
        case 'create_relationship':
          return this.createRelationship(message, userId);
        case 'delete_file':
          return this.deleteFile(message, userId, context);
        case 'create_folder':
          return this.createFolder(message, userId);
        case 'star_file':
          return this.starFile(message, userId, context);
        case 'share_file':
          return this.shareFile(message, userId, context);
        case 'move_file':
          return this.moveFile(message, userId, context);
        case 'rename_file':
          return this.renameFile(message, userId, context);
        case 'create_file_request':
          return this.createFileRequest(message, userId);
        case 'create_file':
          return this.createFile(message, userId);
        case 'create_shortcut':
          return this.createWebShortcut(message, userId);
        case 'create_secured_link':
          return this.createSecuredLink(message, userId);
        case 'create_template':
          return this.createTemplate(message, userId, context);
        case 'create_team_folder':
          return this.createTeamFolder(message, userId);
        case 'create_cloud_backup':
          return this.createCloudBackup(message, userId);
        default:
          return {
            success: false,
            message: `Action type "${action.type}" is not yet supported.`,
          };
      }
    } catch (error) {
      console.error('[AI Action Executor] Error executing action:', error);
      return {
        success: false,
        message: `An error occurred while executing the action: ${error.message}`,
      };
    }
  }
}

module.exports = new AIActionExecutor();
