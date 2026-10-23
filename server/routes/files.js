const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const auth = require('../middleware/auth');
const File = require('../models/File');
const Folder = require('../models/Folder');
const User = require('../models/User');
const FileVersion = require('../models/FileVersion');
const FileContent = require('../models/FileContent');
const Activity = require('../models/Activity');
const analytics = require('../services/analytics');
const appConfig = require('../config/appConfig');
const StudyGroup = require('../models/StudyGroup');
const FileMemory = require('../models/FileMemory');
const { assertAvailable } = require('../utils/optionalModule');
const { authorizeFile, authorizeFolder, sendDenied, capabilitiesFor, getFileRole, readableFileFilter } = require('../services/permissions');
const { logView } = require('../services/activityLog');
const { extractInBackground } = require('../services/backgroundExtraction');
const imageCaption = require('../services/imageCaption');
const { restorableParent } = require('../services/fileResolver');
const { snapshotCurrentVersion, replaceFileContents, newLivePath } = require('../services/fileVersions');
const { purgeFile, purgeFolderTree, purgeTrash, trashSize, RECOVERY_DAYS } = require('../services/trash');
const { buildStorageSummary, recalculateStorage } = require('../services/storageSummary');
const router = express.Router();

// Helper function to log activity
const logActivity = async (user, action, fileId = null, folderId = null, details = '') => {
  try {
    const activity = new Activity({
      user: user._id || user,
      file: fileId,
      folder: folderId,
      action,
      details
    });
    await activity.save();
  } catch (error) {
    console.error('Error logging activity:', error);
  }
};

// A personal file or folder may only be placed inside a folder the user owns.
// Team spaces have their own routes and permission checks.
const resolveOwnedParentFolder = async (parentFolder, userId) => {
  if (!parentFolder || parentFolder === 'root') return { id: null };
  const folder = await Folder.findOne({ _id: parentFolder, owner: userId, isTrashed: { $ne: true } }).select('_id').catch(() => null);
  return folder ? { id: folder._id } : { error: 'Folder not found' };
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const userId = req.user._id.toString();
    const uploadPath = path.join(__dirname, '..', 'uploads', userId);
    await fs.ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: appConfig.upload.maxFileSize
  }
});

// Get file by ID (must be before other routes to avoid conflicts)
router.get('/file/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    if (access.file.isTrashed) return res.status(404).json({ message: 'File not found' });
    await access.file.populate('owner', 'name email');

    res.json({ file: access.file, access: capabilitiesFor(access.role) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get folder by ID
router.get('/folder/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFolder(req.params.id, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    if (access.folder.isTrashed) return res.status(404).json({ message: 'Folder not found' });
    const folder = await access.folder.populate('owner', 'name email');

    res.json({ folder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const ACCESS_LOG_ACTIONS = { view: 'viewed', download: 'downloaded', edit: 'edited', delete: 'deleted' };

// Recently used files: uploads, edits, views, downloads and other file activity by this user.
// Built from real timestamps; files the user can no longer access are left out.
router.get('/recent', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    const [activities, ownedFiles, viewedFiles] = await Promise.all([
      Activity.find({ user: userId, file: { $ne: null } })
        .sort({ createdAt: -1 })
        .limit(300)
        .select('file action createdAt')
        .lean(),
      File.find({ owner: userId, isTrashed: { $ne: true } })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select('_id updatedAt createdAt')
        .lean(),
      File.find({ 'accessLog.userId': userId, isTrashed: { $ne: true } })
        .select('_id accessLog')
        .lean(),
    ]);

    // fileId -> most recent { at, action }
    const lastTouched = new Map();
    const touch = (fileId, at, action) => {
      if (!fileId || !at) return;
      const key = fileId.toString();
      const current = lastTouched.get(key);
      if (!current || new Date(at) > new Date(current.at)) {
        lastTouched.set(key, { at, action });
      }
    };

    activities.forEach(activity => touch(activity.file, activity.createdAt, activity.action));
    ownedFiles.forEach(file => {
      const edited = file.updatedAt && file.createdAt && new Date(file.updatedAt) - new Date(file.createdAt) > 1000;
      touch(file._id, file.updatedAt || file.createdAt, edited ? 'edited' : 'uploaded');
    });
    // Sharing: when you shared a file, or when it was shared with you (share entry ids carry the time).
    const sharingFiles = await File.find({
      isTrashed: { $ne: true },
      $or: [{ owner: userId, 'sharedWith.0': { $exists: true } }, { 'sharedWith.user': userId }],
    }).select('owner sharedWith').lean();
    sharingFiles.forEach(file => {
      const mine = file.owner.toString() === userId.toString();
      (file.sharedWith || [])
        .filter(entry => mine || entry.user?.toString() === userId.toString())
        .forEach(entry => touch(file._id, entry._id.getTimestamp(), mine ? 'shared' : 'shared_with_you'));
    });

    viewedFiles.forEach(file => {
      (file.accessLog || [])
        .filter(entry => entry.userId?.toString() === userId.toString())
        .forEach(entry => touch(file._id, entry.timestamp, ACCESS_LOG_ACTIONS[entry.action] || 'viewed'));
    });

    const files = await File.find({
      ...(await readableFileFilter(userId)),
      _id: { $in: [...lastTouched.keys()] },
    }).populate('owner', 'name email');

    const withAccess = await Promise.all(files.map(async (file) => {
      const role = await getFileRole(file, userId);
      const item = file.toObject();
      // Don't expose other recipients or server paths on files someone else owns.
      if (role !== 'owner') {
        delete item.path;
        delete item.sharedWith;
        delete item.accessLog;
      }
      return { ...item, access: role };
    }));

    const recent = withAccess
      .map(file => ({
        ...file,
        lastInteractionAt: lastTouched.get(file._id.toString()).at,
        lastInteraction: lastTouched.get(file._id.toString()).action,
      }))
      .sort((a, b) => new Date(b.lastInteractionAt) - new Date(a.lastInteractionAt))
      .slice(0, limit);

    res.json({ files: recent });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Trash summary: size, item counts and how long items are kept
router.get('/trash/summary', auth, async (req, res) => {
  try {
    const { folderIds, ...summary } = await trashSize(req.user._id);
    res.json({ ...summary, recoveryDays: RECOVERY_DAYS });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Storage overview: usage, categories, large files, duplicates, Trash
router.get('/storage/summary', auth, async (req, res) => {
  try {
    res.json(await buildStorageSummary(req.user._id));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Reset the account's storage counter to the measured total of its files
router.post('/storage/recalculate', auth, async (req, res) => {
  try {
    const storageUsed = await recalculateStorage(req.user._id);
    res.json({ storageUsed });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Empty Trash. The client must send { confirm: true } after asking the user.
router.delete('/trash', auth, async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ message: 'Emptying Trash requires confirmation' });
    }
    const counts = await purgeTrash({ userId: req.user._id });
    req.app.get('io').to(`user-${req.user._id}`).emit('trash-emptied', counts);
    res.json({ message: 'Trash emptied', ...counts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Get all files and folders
router.get('/', auth, async (req, res) => {
  try {
    const { folderId, trashed, starred } = req.query;
    const query = { owner: req.user._id, isTrashed: trashed === 'true' };

    // Filter by starred status if requested
    if (starred === 'true') {
      query.isStarred = true;
    }

    if (folderId) {
      query.parentFolder = folderId === 'root' ? null : folderId;
    } else if (trashed !== 'true' && starred !== 'true') {
      // Trash and Starred list items from every folder, not just the root.
      query.parentFolder = null;
    }

    const files = await File.find(query).populate('owner', 'name email').sort({ createdAt: -1 });

    // Exclude course folders and study group folders from regular Files view
    const folderQuery = { ...query, isCourseFolder: { $ne: true } };

    // Get all study group folder IDs to exclude
    const studyGroups = await StudyGroup.find({
      $or: [
        { creator: req.user._id },
        { 'members.user': req.user._id }
      ]
    }).select('folder').lean();

    const studyGroupFolderIds = studyGroups
      .map(sg => sg.folder)
      .filter(id => id !== null && id !== undefined);

    // Exclude study group folders by ID and by name pattern
    const exclusionConditions = [];

    // Exclude by folder ID if we found any study group folders
    if (studyGroupFolderIds.length > 0) {
      exclusionConditions.push({ _id: { $nin: studyGroupFolderIds } });
    }

    // Always exclude folders that start with "Study Group:" as a fallback
    exclusionConditions.push({ name: { $not: /^Study Group:/ } });

    // Combine exclusion conditions with $and
    if (exclusionConditions.length > 0) {
      folderQuery.$and = exclusionConditions;
    }

    const folders = await Folder.find(folderQuery).populate('owner', 'name email').sort({ createdAt: -1 });

    // Trash shows where each item used to live.
    if (trashed === 'true') {
      const parentIds = [...new Set([...files, ...folders].map(item => item.parentFolder?.toString()).filter(Boolean))];
      const parents = await Folder.find({ _id: { $in: parentIds } }).select('name').lean();
      const names = new Map(parents.map(folder => [folder._id.toString(), folder.name]));
      const withLocation = (item) => ({
        ...item.toObject(),
        originalLocation: item.parentFolder ? (names.get(item.parentFolder.toString()) || 'Deleted folder') : 'My Files',
      });
      return res.json({ files: files.map(withLocation), folders: folders.map(withLocation), recoveryDays: RECOVERY_DAYS });
    }

    res.json({ files, folders });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Upload file
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      await fs.remove(req.file.path);
      return res.status(404).json({ message: 'User not found' });
    }

    const fileSize = req.file.size;

    // Check storage limit
    if (user.storageUsed + fileSize > user.storageLimit) {
      await fs.remove(req.file.path);
      return res.status(400).json({ message: 'Storage limit exceeded' });
    }

    const { parentFolder } = req.body;
    const parent = await resolveOwnedParentFolder(parentFolder, req.user._id);
    if (parent.error) {
      await fs.remove(req.file.path);
      return res.status(404).json({ message: parent.error });
    }

    const file = new File({
      name: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: fileSize,
      mimeType: req.file.mimetype,
      owner: req.user._id,
      parentFolder: parent.id
    });

    await file.save();
    user.storageUsed += fileSize;
    await user.save();
    await logActivity(req.user._id, 'uploaded', file._id, null, file.originalName);

    // Create file memory context
    try {
      const { userAction, projectContext, meetingContext, deadlineContext } = req.body;
      const fileMemory = new FileMemory({
        file: file._id,
        owner: req.user._id,
        creationContext: {
          timestamp: new Date(),
          source: 'upload',
          userAction: userAction || '',
          relatedFiles: [],
          relatedFolders: parentFolder && parentFolder !== 'root' ? [parentFolder] : [],
          projectContext: projectContext || '',
          meetingContext: meetingContext || '',
          deadlineContext: deadlineContext ? new Date(deadlineContext) : null
        }
      });
      await fileMemory.save();
    } catch (memoryError) {
      console.error('Error creating file memory:', memoryError);
      // Don't fail the upload if memory creation fails
    }

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${req.user._id}`).emit('file-uploaded', file);
    }

    await file.populate('owner', 'name email');

    // Send response before background processing
    res.status(201).json(file);

    // Read the file's text in the background so File Box AI can search and answer from it.
    extractInBackground(file);
    // Pictures also get a fun caption from the local vision model.
    imageCaption.captionInBackground(file);
  } catch (error) {
    console.error('Upload error:', error);
    // Clean up uploaded file if it exists
    if (req.file && req.file.path) {
      try {
        await fs.remove(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    res.status(500).json({ message: error.message || 'Failed to upload file' });
  }
});

// Create folder
router.post('/folder', auth, async (req, res) => {
  try {
    const { name, parentFolder } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Folder name is required' });
    }

    const parent = await resolveOwnedParentFolder(parentFolder, req.user._id);
    if (parent.error) {
      return res.status(404).json({ message: parent.error });
    }

    const folder = new Folder({
      name,
      owner: req.user._id,
      parentFolder: parent.id
    });

    await folder.save();
    await logActivity(req.user._id, 'created', null, folder._id, `Folder: ${folder.name}`);

    // Emit real-time update
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('folder-created', folder);

    res.status(201).json(folder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// A picture's AI caption (cards ask while it is being written).
router.get('/:id/caption', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    const { file } = access;
    res.json({ canCaption: imageCaption.canCaption(file), caption: file.aiCaption || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Ask for a caption (or a different one). Saved on the file, so it needs edit access.
router.post('/:id/caption', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;
    if (!imageCaption.canCaption(file)) return res.status(400).json({ message: 'Captions are only for pictures.' });
    const again = Boolean(file.aiCaption?.text);
    if (!imageCaption.captionInBackground(file, { again })) {
      return res.status(503).json({ message: 'File Box AI is turned off.' });
    }
    res.status(202).json({ caption: { ...(file.aiCaption?.toObject?.() || {}), status: 'writing', error: '' } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download file
router.get('/download/:id', auth, async (req, res) => {
  try {
    console.log(`[Download] Request for file ${req.params.id} by user ${req.user._id}`);
    const access = await authorizeFile(req.params.id, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    const { file } = access;

    console.log(`[Download] File found: ${file.originalName}, owner: ${file.owner}, path: ${file.path}`);

    const pathExists = await fs.pathExists(file.path);
    console.log(`[Download] File path exists: ${pathExists}, path: ${file.path}`);

    if (!pathExists) {
      console.error(`[Download] File path does not exist: ${file.path} for file ${file._id}`);
      return res.status(404).json({ message: 'File not found on disk. The file may have been deleted.' });
    }

    // Card thumbnails for images: shown while browsing, so they are not counted as views or downloads.
    if (req.query.purpose === 'thumbnail') {
      if (!String(file.mimeType || '').startsWith('image/')) return res.status(415).json({ message: 'Only images have thumbnails.' });
      res.set('Cache-Control', 'private, max-age=300');
      return res.type(file.mimeType).sendFile(require('path').resolve(file.path));
    }

    // Track activity - notify owner if this is a shared file
    const isSharedFile = file.owner.toString() !== req.user._id.toString();

    // Opening a file to look at it (previews ask with ?purpose=view) is a view, not a download.
    const isView = req.query.purpose === 'view';
    if (isView) {
      await logView(req.user._id, file);
    } else {
      await logActivity(req.user._id, 'downloaded', file._id, null, file.originalName);
    }
    // Record analytics
    await analytics.recordActivity(file._id, req.user._id, isView ? 'view' : 'download', {
      fileName: file.originalName,
      isSharedFile
    });

    // Notify file owner in real-time if someone else is downloading
    if (isSharedFile) {
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${file.owner}`).emit('shared-file-accessed', {
          file: {
            _id: file._id,
            originalName: file.originalName
          },
          accessedBy: {
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email
          },
          action: 'download',
          timestamp: new Date()
        });
      }
    }

    // Update access log
    const ipAddress = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    file.accessLog.push({
      userId: req.user._id,
      action: 'download',
      timestamp: new Date(),
      ipAddress
    });
    await file.save();

    // Update file memory usage patterns (non-blocking)
    if (file.owner.toString() === req.user._id.toString()) {
      setImmediate(async () => {
        try {
          const axios = require('axios');
          await axios.patch(`${req.protocol}://${req.get('host')}/api/file-memory/file/${file._id}/usage`, {}, {
            headers: { 'Authorization': req.headers.authorization }
          });
        } catch (err) {
          // Silent fail - usage tracking is not critical
        }
      });
    }

    console.log(`[Download] Sending file: ${file.path}`);
    res.download(file.path, file.originalName, (err) => {
      if (err) {
        console.error(`[Download] Error sending file:`, err);
        if (!res.headersSent) {
          res.status(500).json({ message: `Failed to download file: ${err.message}` });
        }
      } else {
        console.log(`[Download] File sent successfully: ${file.originalName}`);
      }
    });
  } catch (error) {
    console.error(`[Download] Unexpected error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || 'An error occurred while downloading the file' });
    }
  }
});

// Track file view
router.post('/view/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    const { file } = access;

    // Track activity - notify owner if this is a shared file
    const isSharedFile = file.owner.toString() !== req.user._id.toString();

    // Update access log
    const ipAddress = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    file.accessLog.push({
      userId: req.user._id,
      action: 'view',
      timestamp: new Date(),
      ipAddress
    });
    await file.save();

    // Record analytics
    await analytics.recordActivity(file._id, req.user._id, 'view', {
      fileName: file.originalName,
      isSharedFile
    });

    // Update file memory usage patterns (non-blocking)
    if (file.owner.toString() === req.user._id.toString()) {
      setImmediate(async () => {
        try {
          const axios = require('axios');
          await axios.patch(`${req.protocol}://${req.get('host')}/api/file-memory/file/${file._id}/usage`, {}, {
            headers: { 'Authorization': req.headers.authorization }
          });
        } catch (err) {
          // Silent fail - usage tracking is not critical
        }
      });
    }

    // Notify file owner in real-time if someone else is viewing
    if (isSharedFile) {
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${file.owner}`).emit('shared-file-accessed', {
          file: {
            _id: file._id,
            originalName: file.originalName
          },
          accessedBy: {
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email
          },
          action: 'view',
          timestamp: new Date()
        });
      }
    }

    res.json({ message: 'View tracked' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete file/folder
router.delete('/:id', auth, async (req, res) => {
  try {
    const { type } = req.query; // 'file' or 'folder'

    if (type === 'folder') {
      const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { folder } = access;
      folder.isTrashed = true;
      folder.deletedAt = new Date();
      await folder.save();

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-deleted', folder);

      res.json({ message: 'Folder moved to trash' });
    } else {
      const access = await authorizeFile(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { file } = access;

      file.isTrashed = true;
      file.deletedAt = new Date();
      await file.save();

      // Log activity
      await logActivity(req.user._id, 'deleted', file._id, null, file.originalName);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('file-deleted', file);

      res.json({ message: 'File moved to trash' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Permanently delete
router.delete('/permanent/:id', auth, async (req, res) => {
  try {
    const { type } = req.query;
    const io = req.app.get('io');

    if (type === 'folder') {
      const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { folder } = access;
      if (!folder.isTrashed) {
        return res.status(400).json({ message: 'Move the folder to Trash before deleting it permanently' });
      }

      const counts = await purgeFolderTree(folder);
      io.to(`user-${req.user._id}`).emit('folder-permanently-deleted', folder);
      res.json({ message: 'Folder permanently deleted', ...counts });
    } else {
      const access = await authorizeFile(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { file } = access;
      if (!file.isTrashed) {
        return res.status(400).json({ message: 'Move the file to Trash before deleting it permanently' });
      }

      await purgeFile(file);
      io.to(`user-${req.user._id}`).emit('file-permanently-deleted', file);
      res.json({ message: 'File permanently deleted' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/restore/:id', auth, async (req, res) => {
  try {
    const { type } = req.query;

    if (type === 'folder') {
      const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { folder } = access;
      folder.isTrashed = false;
      folder.deletedAt = null;
      if (!(await restorableParent(folder.parentFolder, req.user._id))) folder.parentFolder = null;
      await folder.save();

      // Log activity
      await logActivity(req.user._id, 'restored', null, folder._id, `Folder: ${folder.name}`);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-restored', folder);

      res.json(folder);
    } else {
      const access = await authorizeFile(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { file } = access;
      file.isTrashed = false;
      file.deletedAt = null;
      if (!(await restorableParent(file.parentFolder, req.user._id))) file.parentFolder = null;
      await file.save();

      // Log activity
      await logActivity(req.user._id, 'restored', file._id, null, file.originalName);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('file-restored', file);

      res.json(file);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Star/unstar
router.post('/star/:id', auth, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { type } = req.query;

    if (type === 'folder') {
      const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { folder } = access;
      folder.isStarred = !folder.isStarred;
      await folder.save();

      // Log activity
      await logActivity(req.user._id, folder.isStarred ? 'starred' : 'unstarred', null, folder._id, `Folder: ${folder.name}`);

      // Emit socket event
      if (io) {
        io.to(`user-${req.user._id}`).emit(folder.isStarred ? 'file-starred' : 'file-unstarred', { type: 'folder', id: folder._id });
      }

      res.json(folder);
    } else {
      const access = await authorizeFile(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { file } = access;
      file.isStarred = !file.isStarred;
      await file.save();

      // Log activity
      await logActivity(req.user._id, file.isStarred ? 'starred' : 'unstarred', file._id, null, file.originalName);
      // Record analytics
      await analytics.recordActivity(file._id, req.user._id, file.isStarred ? 'star' : 'unstar', { fileName: file.originalName });

      // Emit socket event
      if (io) {
        io.to(`user-${req.user._id}`).emit(file.isStarred ? 'file-starred' : 'file-unstarred', { type: 'file', id: file._id });
      }

      res.json(file);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Rename
router.patch('/rename/:id', auth, async (req, res) => {
  try {
    const { name, type } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    if (type === 'folder') {
      const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { folder } = access;
      folder.name = name;
      await folder.save();

      // Log activity
      await logActivity(req.user._id, 'renamed', null, folder._id, `Renamed to: ${name}`);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-renamed', folder);

      res.json(folder);
    } else {
      const access = await authorizeFile(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { file } = access;
      file.originalName = name;
      await file.save();

      // Log activity
      await logActivity(req.user._id, 'renamed', file._id, null, `Renamed to: ${name}`);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('file-renamed', file);

      res.json(file);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Move file/folder
router.patch('/move/:id', auth, async (req, res) => {
  try {
    const { type, targetFolderId } = req.body;

    if (type === 'folder') {
      const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { folder } = access;

      // Prevent moving folder into itself or its children
      if (targetFolderId && targetFolderId !== 'root') {
        const targetFolder = await Folder.findById(targetFolderId);
        if (!targetFolder || targetFolder.owner.toString() !== req.user._id.toString()) {
          return res.status(404).json({ message: 'Target folder not found' });
        }

        // Check if target is a child of the folder being moved
        let currentParent = targetFolder.parentFolder;
        while (currentParent) {
          if (currentParent.toString() === folder._id.toString()) {
            return res.status(400).json({ message: 'Cannot move folder into its own subfolder' });
          }
          const parentFolder = await Folder.findById(currentParent);
          currentParent = parentFolder ? parentFolder.parentFolder : null;
        }
      }

      folder.parentFolder = targetFolderId && targetFolderId !== 'root' ? targetFolderId : null;
      await folder.save();

      // Log activity
      await logActivity(req.user._id, 'moved', null, folder._id, `Folder: ${folder.name}`);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-moved', folder);

      res.json(folder);
    } else {
      const access = await authorizeFile(req.params.id, req.user._id, 'owner');
      if (sendDenied(res, access)) return;
      const { file } = access;

      if (targetFolderId && targetFolderId !== 'root') {
        const targetFolder = await Folder.findById(targetFolderId);
        if (!targetFolder || targetFolder.owner.toString() !== req.user._id.toString()) {
          return res.status(404).json({ message: 'Target folder not found' });
        }
      }

      const sourceFolderId = file.parentFolder;
      file.parentFolder = targetFolderId && targetFolderId !== 'root' ? targetFolderId : null;
      await file.save();

      // Log activity
      await logActivity(req.user._id, 'moved', file._id, null, file.originalName);

      // Record pattern for predictive organization (non-blocking)
      if (sourceFolderId !== file.parentFolder) {
        setImmediate(async () => {
          try {
            assertAvailable(path.join(__dirname, '../services/predictiveOrganization.js'));
            const predictiveOrgService = require('../services/predictiveOrganization');
            await predictiveOrgService.recordPattern(
              req.user._id,
              file,
              sourceFolderId,
              file.parentFolder,
              {
                actionBefore: 'moved',
                projectContext: null // Can be enhanced with file memory context
              }
            );
          } catch (err) {
            console.error('Error recording organization pattern:', err);
            // Silent fail - pattern tracking is not critical
          }
        });
      }

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('file-moved', file);

      res.json(file);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Copy file
router.post('/copy/:id', auth, async (req, res) => {
  try {
    const { targetFolderId } = req.body;
    const access = await authorizeFile(req.params.id, req.user._id, 'owner');
    if (sendDenied(res, access)) return;
    const { file } = access;

    if (targetFolderId && targetFolderId !== 'root') {
      const targetFolder = await Folder.findById(targetFolderId);
      if (!targetFolder || targetFolder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Target folder not found' });
      }
    }

    // Read the original file
    const originalPath = file.path;
    if (!await fs.pathExists(originalPath)) {
      return res.status(404).json({ message: 'Original file not found on disk' });
    }

    // Create new file entry
    const newFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalName)}`;
    const userId = req.user._id.toString();
    const newPath = path.join(__dirname, '..', 'uploads', userId, newFileName);

    await fs.copy(originalPath, newPath);

    const newFile = new File({
      name: newFileName,
      originalName: `Copy of ${file.originalName}`,
      path: newPath,
      size: file.size,
      mimeType: file.mimeType,
      owner: req.user._id,
      parentFolder: targetFolderId && targetFolderId !== 'root' ? targetFolderId : null
    });

    await newFile.save();

    // Update user storage
    const user = await User.findById(req.user._id);
    user.storageUsed += file.size;
    await user.save();

      // Log activity
      await logActivity(req.user._id, 'copied', newFile._id, null, `Copied: ${newFile.originalName}`);

      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('file-copied', newFile);

      res.status(201).json(newFile);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download folder as ZIP
router.get('/download-folder/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
    if (sendDenied(res, access)) return;
    const { folder } = access;

    // Recursive function to get all files in folder and subfolders
    const getAllFiles = async (folderId, basePath = '') => {
      const files = await File.find({ parentFolder: folderId, isTrashed: false });
      const subfolders = await Folder.find({ parentFolder: folderId, isTrashed: false });
      const allFiles = [];

      // Add files in current folder
      for (const file of files) {
        allFiles.push({
          path: path.join(basePath, file.originalName),
          filePath: file.path
        });
      }

      // Recursively get files from subfolders
      for (const subfolder of subfolders) {
        const subfolderFiles = await getAllFiles(subfolder._id, path.join(basePath, subfolder.name));
        allFiles.push(...subfolderFiles);
      }

      return allFiles;
    };

    const allFiles = await getAllFiles(folder._id, folder.name);

    if (allFiles.length === 0) {
      return res.status(400).json({ message: 'Folder is empty' });
    }

    // Create ZIP archive
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.attachment(`${folder.name}.zip`);
    archive.pipe(res);

    // Add files to archive
    for (const file of allFiles) {
      if (await fs.pathExists(file.filePath)) {
        archive.file(file.filePath, { name: file.path });
      }
    }

    await archive.finalize();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get file versions
router.get('/versions/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;

    const versions = await FileVersion.find({ file: req.params.id })
      .populate('uploadedBy', 'name email')
      .sort({ versionNumber: -1 });

    res.json(versions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download specific version
router.get('/version/:versionId/download', auth, async (req, res) => {
  try {
    const version = await FileVersion.findById(req.params.versionId)
      .populate('file');

    if (!version) {
      return res.status(404).json({ message: 'Version not found' });
    }

    const access = await authorizeFile(version.file?._id, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;

    if (!await fs.pathExists(version.path)) {
      return res.status(404).json({ message: 'Version file not found on disk' });
    }

    res.download(version.path, `v${version.versionNumber}_${file.originalName}`);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Restore to specific version
router.post('/version/:versionId/restore', auth, async (req, res) => {
  try {
    const version = await FileVersion.findById(req.params.versionId)
      .populate('file');

    if (!version) {
      return res.status(404).json({ message: 'Version not found' });
    }

    const access = await authorizeFile(version.file?._id, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;

    if (!(await fs.pathExists(version.path))) {
      return res.status(404).json({ message: 'This version is no longer available on disk' });
    }

    // Keep the current contents as a version, then copy the chosen version back in.
    await snapshotCurrentVersion(file, req.user._id, `Before restoring version ${version.versionNumber}`);
    const restoredPath = newLivePath(file, path.extname(version.path) || path.extname(file.originalName));
    await fs.copy(version.path, restoredPath);
    await replaceFileContents(file, restoredPath, version.size);

    await logActivity(req.user._id, 'version_restored', file._id, null, `Restored to version ${version.versionNumber}`);

    res.json(file);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get file activity
router.get('/activity/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'owner');
    if (sendDenied(res, access)) return;
    const { file } = access;

    const activities = await Activity.find({ file: req.params.id })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(activities);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get folder activity
router.get('/folder-activity/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFolder(req.params.id, req.user._id, 'owner');
    if (sendDenied(res, access)) return;
    const { folder } = access;

    const activities = await Activity.find({ folder: req.params.id })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(activities);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get extracted text for preview (for DOCX, PDF, etc.)
router.get('/preview-text/:id', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    const { file } = access;
    await logView(req.user._id, file);

    // Check if we have extracted text in FileContent
    let fileContent = await FileContent.findOne({ file: file._id });

    if (fileContent && fileContent.extractedText && fileContent.extractedText.length > 0) {
      return res.json({
        text: fileContent.extractedText,
        textLength: fileContent.extractedText.length
      });
    }

    // If no extracted text exists, try to extract it now
    const textExtractor = require('../services/textExtractor');

    // Check if extraction is supported (for Word docs, PDFs, etc.)
    const mimeType = file.mimeType.toLowerCase();
    const isWordDoc = mimeType.includes('word') ||
                      mimeType.includes('document') ||
                      mimeType.includes('msword') ||
                      mimeType.includes('vnd.openxmlformats-officedocument.wordprocessingml');
    const isSupported = isWordDoc ||
                       mimeType.includes('pdf') ||
                       mimeType.startsWith('text/') ||
                       (textExtractor.isSupported && textExtractor.isSupported(file.mimeType));

    if (!isSupported) {
      return res.status(400).json({
        message: 'Text extraction not supported for this file type'
      });
    }

    // Extract text
    console.log(`[Preview] Extracting text from: ${file.originalName} (${file.mimeType})`);
    const extractedText = await textExtractor.extractText(file.path, file.mimeType);

    if (!extractedText || extractedText.trim().length === 0) {
      // For DOCX files, check if file exists and is valid
      if (isWordDoc) {
        const fs = require('fs-extra');
        const fileExists = await fs.pathExists(file.path);
        if (!fileExists) {
          return res.status(404).json({
            message: 'File not found on disk'
          });
        }
        // Check file size - if it's very small, it might be empty
        const stats = await fs.stat(file.path);
        if (stats.size < 100) {
          return res.status(400).json({
            message: 'File appears to be empty or corrupted'
          });
        }
      }
      return res.status(400).json({
        message: 'No text could be extracted from this file. The file may be empty, corrupted, or in an unsupported format.'
      });
    }

    // Validate extracted text - make sure it's not binary data
    const textPreview = extractedText.substring(0, 200);
    // Check for common binary/XML patterns that indicate we got raw DOCX content
    if (textPreview.includes('PK') && textPreview.includes('<?xml') &&
        (textPreview.match(/[<>]/g)?.length || 0) > 20) {
      console.error(`[Preview] ⚠️ Extracted text appears to be raw binary/XML data for: ${file.originalName}`);
      return res.status(500).json({
        message: 'Text extraction returned invalid data. Please try again or download the file.'
      });
    }

    // Save to FileContent for future use
    if (!fileContent) {
      fileContent = new FileContent({
        file: file._id,
        extractedText,
        extractionStatus: 'completed'
      });
    } else {
      fileContent.extractedText = extractedText;
      fileContent.extractionStatus = 'completed';
    }
    await fileContent.save();

    res.json({
      text: extractedText,
      textLength: extractedText.length
    });
  } catch (error) {
    console.error('Error getting preview text:', error);
    res.status(500).json({ message: 'Failed to get preview text', error: error.message });
  }
});

// Get user activity
router.get('/activity', auth, async (req, res) => {
  try {
    const activities = await Activity.find({ user: req.user._id })
      .populate('file', 'originalName')
      .populate('folder', 'name')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(activities);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update file (for TXT and other text files)
router.put('/update/:id', auth, upload.single('file'), async (req, res) => {
  try {
    const access = await authorizeFile(req.params.id, req.user._id, 'editor');
    if (sendDenied(res, access)) {
      if (req.file) await fs.remove(req.file.path);
      return;
    }
    const { file } = access;

    if (!req.file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    // Keep the previous contents as a version; the name stays the same.
    await snapshotCurrentVersion(file, req.user._id, req.body.changeDescription || 'Previous version');
    await replaceFileContents(file, req.file.path, req.file.size);

    await logActivity(req.user._id, 'edited', file._id, null, `Updated ${file.originalName}`);

    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('file-updated', file);
    io.to(`user-${file.owner}`).emit('file-updated', file);

    res.json(file);
  } catch (error) {
    console.error('Error updating file:', error);
    res.status(500).json({ message: error.message });
  }
});

router.put('/update-docx/:id', auth, async (req, res) => {
  try {
    const { text, fileName } = req.body;
    const access = await authorizeFile(req.params.id, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;

    const docx = require('docx');
    const fs = require('fs-extra');
    const path = require('path');


    // Convert text to DOCX paragraphs
    const paragraphs = text.split('\n').map((line) =>
      new docx.Paragraph({
        children: [new docx.TextRun(line || ' ')],
      })
    );

    // Create DOCX document
    const doc = new docx.Document({
      sections: [{
        properties: {},
        children: paragraphs,
      }],
    });

    // Generate DOCX buffer
    const buffer = await docx.Packer.toBuffer(doc);

    // Keep the previous contents as a version, then write the new contents.
    await snapshotCurrentVersion(file, req.user._id, 'Previous version');
    const newPath = newLivePath(file, '.docx');
    await fs.ensureDir(path.dirname(newPath));
    await fs.writeFile(newPath, buffer);
    if (fileName) {
      file.originalName = fileName.endsWith('.docx') ? fileName : fileName + '.docx';
    }
    await replaceFileContents(file, newPath, buffer.length);

    // Log activity
    await logActivity(req.user._id, 'edited', file._id, null, `Updated ${file.originalName}`);

    // Emit real-time update
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('file-updated', file);

    res.json(file);
  } catch (error) {
    console.error('Error updating DOCX file:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update PDF file from text content
router.put('/update-pdf/:id', auth, async (req, res) => {
  try {
    const { text, fileName } = req.body;
    const access = await authorizeFile(req.params.id, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;

    const fs = require('fs-extra');
    const path = require('path');

    // Try to use pdf-lib if available, otherwise use a simple text-to-PDF approach
    let pdfBytes;
    try {
      const { PDFDocument, StandardFonts } = require('pdf-lib');

      // Create new PDF document
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // Split text into pages (approximately 50 lines per page)
      const lines = text.split('\n');
      const linesPerPage = 50;
      const pages = [];

      for (let i = 0; i < lines.length; i += linesPerPage) {
        pages.push(lines.slice(i, i + linesPerPage));
      }

      if (pages.length === 0) {
        pages.push(['']);
      }

      // Add pages with text
      pages.forEach((pageLines) => {
        const page = pdfDoc.addPage([612, 792]); // US Letter size
        const pageText = pageLines.join('\n');
        page.drawText(pageText, {
          x: 50,
          y: 750,
          size: 12,
          font: font,
          maxWidth: 512,
        });
      });

      // Generate PDF bytes
      pdfBytes = await pdfDoc.save();
    } catch (pdfLibError) {
      // Fallback: Create a simple text-based PDF
      // Note: Install pdf-lib for better PDF generation: npm install pdf-lib
      console.log('pdf-lib not available, using fallback method:', pdfLibError.message);

      // Create a minimal PDF structure
      const escapedText = text.replace(/[()\\]/g, '\\$&').substring(0, 1000); // Limit length
      const pdfText = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${escapedText.length + 50} >>
stream
BT
/F1 12 Tf
50 750 Td
(${escapedText}) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000300 00000 n
0000000500 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
600
%%EOF`;

      pdfBytes = Buffer.from(pdfText);
    }

    // Keep the previous contents as a version, then write the new contents.
    await snapshotCurrentVersion(file, req.user._id, 'Previous version');
    const newPath = newLivePath(file, '.pdf');
    await fs.ensureDir(path.dirname(newPath));
    await fs.writeFile(newPath, pdfBytes);
    if (fileName) {
      file.originalName = fileName.endsWith('.pdf') ? fileName : fileName + '.pdf';
    }
    await replaceFileContents(file, newPath, pdfBytes.length);

    // Log activity
    await logActivity(req.user._id, 'edited', file._id, null, `Updated ${file.originalName}`);

    // Emit real-time update
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('file-updated', file);

    res.json(file);
  } catch (error) {
    console.error('Error updating PDF file:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

