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
const documentProcessingService = require('../services/documentProcessingService');
const {
  buildDocxBufferFromHtml,
  buildPdfBytesFromHtml,
  htmlToPlainText,
} = require('../services/richDocumentBuilder');
const router = express.Router();

const createHtmlFromText = (text = '') => {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`);

  return paragraphs.length > 0 ? paragraphs.join('') : '<p></p>';
};

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
    const file = await File.findOne({
      _id: req.params.id,
      owner: req.user._id,
      isTrashed: { $ne: true }
    }).populate('owner', 'name email');

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    res.json({ file });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get folder by ID
router.get('/folder/:id', auth, async (req, res) => {
  try {
    const folder = await Folder.findOne({
      _id: req.params.id,
      owner: req.user._id,
      isTrashed: { $ne: true }
    }).populate('owner', 'name email');

    if (!folder) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    res.json({ folder });
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
    } else {
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
    const file = new File({
      name: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: fileSize,
      mimeType: req.file.mimetype,
      owner: req.user._id,
      parentFolder: parentFolder && parentFolder !== 'root' ? parentFolder : null
    });

    await file.save();
    user.storageUsed += fileSize;
    await user.save();

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

    await documentProcessingService.queueFileProcessing(file, {
      force: true,
    });
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

    const folder = new Folder({
      name,
      owner: req.user._id,
      parentFolder: parentFolder && parentFolder !== 'root' ? parentFolder : null
    });

    await folder.save();

    // Emit real-time update
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('folder-created', folder);

    res.status(201).json(folder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download file
router.get('/download/:id', auth, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check permissions
    if (file.owner.toString() !== req.user._id.toString() && 
        !file.sharedWith.some(s => s.user.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (!await fs.pathExists(file.path)) {
      return res.status(404).json({ message: 'File not found on disk' });
    }

    // Track activity - notify owner if this is a shared file
    const isSharedFile = file.owner.toString() !== req.user._id.toString();
    
    // Log activity
    await logActivity(req.user._id, 'downloaded', file._id, null, file.originalName);
    // Record analytics
    await analytics.recordActivity(file._id, req.user._id, 'download', { 
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

    res.download(file.path, file.originalName);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Track file view
router.post('/view/:id', auth, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check permissions
    if (file.owner.toString() !== req.user._id.toString() && 
        !file.sharedWith.some(s => s.user.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied' });
    }

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
      const folder = await Folder.findById(req.params.id);
      if (!folder || folder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      folder.isTrashed = true;
      folder.deletedAt = new Date();
      await folder.save();
      
      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-deleted', folder);
      
      res.json({ message: 'Folder moved to trash' });
    } else {
      const file = await File.findById(req.params.id);
      if (!file || file.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'File not found' });
      }
      
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
    
    if (type === 'folder') {
      const folder = await Folder.findById(req.params.id);
      if (!folder || folder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      await folder.deleteOne();
      
      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-permanently-deleted', folder);
      
      res.json({ message: 'Folder permanently deleted' });
    } else {
      const file = await File.findById(req.params.id);
      if (!file || file.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'File not found' });
      }
      
      // Delete physical file
      if (await fs.pathExists(file.path)) {
        await fs.remove(file.path);
      }
      
      // Update user storage
      const user = await User.findById(req.user._id);
      user.storageUsed -= file.size;
      await user.save();
      
      await file.deleteOne();
      
      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('file-permanently-deleted', file);
      
      res.json({ message: 'File permanently deleted' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Restore from trash
router.post('/restore/:id', auth, async (req, res) => {
  try {
    const { type } = req.query;
    
    if (type === 'folder') {
      const folder = await Folder.findById(req.params.id);
      if (!folder || folder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      folder.isTrashed = false;
      folder.deletedAt = null;
      await folder.save();
      
      // Log activity
      await logActivity(req.user._id, 'restored', null, folder._id, `Folder: ${folder.name}`);
      
      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-restored', folder);
      
      res.json(folder);
    } else {
      const file = await File.findById(req.params.id);
      if (!file || file.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'File not found' });
      }
      file.isTrashed = false;
      file.deletedAt = null;
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
      const folder = await Folder.findById(req.params.id);
      if (!folder || folder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Folder not found' });
      }
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
      const file = await File.findById(req.params.id);
      if (!file || file.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'File not found' });
      }
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
      const folder = await Folder.findById(req.params.id);
      if (!folder || folder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      folder.name = name;
      await folder.save();
      
      // Log activity
      await logActivity(req.user._id, 'renamed', null, folder._id, `Renamed to: ${name}`);
      
      const io = req.app.get('io');
      io.to(`user-${req.user._id}`).emit('folder-renamed', folder);
      
      res.json(folder);
    } else {
      const file = await File.findById(req.params.id);
      if (!file || file.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'File not found' });
      }
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
      const folder = await Folder.findById(req.params.id);
      if (!folder || folder.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      
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
      const file = await File.findById(req.params.id);
      if (!file || file.owner.toString() !== req.user._id.toString()) {
        return res.status(404).json({ message: 'File not found' });
      }
      
      if (targetFolderId && targetFolderId !== 'root') {
        const targetFolder = await Folder.findById(targetFolderId);
        if (!targetFolder || targetFolder.owner.toString() !== req.user._id.toString()) {
          return res.status(404).json({ message: 'Target folder not found' });
        }
      }
      
      file.parentFolder = targetFolderId && targetFolderId !== 'root' ? targetFolderId : null;
      await file.save();
      
      // Log activity
      await logActivity(req.user._id, 'moved', file._id, null, file.originalName);
      
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
    const file = await File.findById(req.params.id);
    
    if (!file || file.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'File not found' });
    }
    
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
    const folder = await Folder.findById(req.params.id);
    
    if (!folder || folder.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'Folder not found' });
    }

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
    const file = await File.findById(req.params.id);
    if (!file || file.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'File not found' });
    }

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

    const file = version.file;
    if (file.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

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

    const file = version.file;
    if (file.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Create new version from current state before restoring
    const latestVersion = await FileVersion.findOne({ file: file._id })
      .sort({ versionNumber: -1 })
      .limit(1);

    const backupVersion = new FileVersion({
      file: file._id,
      versionNumber: latestVersion ? latestVersion.versionNumber + 1 : 1,
      path: file.path,
      size: file.size,
      uploadedBy: req.user._id,
      changeDescription: 'Backup before restore'
    });
    await backupVersion.save();

    // Restore file from version
    if (await fs.pathExists(version.path)) {
      const newFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalName)}`;
      const userId = req.user._id.toString();
      const newPath = path.join(__dirname, '..', 'uploads', userId, newFileName);
      await fs.copy(version.path, newPath);

      file.path = newPath;
      file.size = version.size;
      file.updatedAt = new Date();
      await file.save();

      const restoredVersion = new FileVersion({
        file: file._id,
        versionNumber: backupVersion.versionNumber + 1,
        path: newPath,
        size: version.size,
        uploadedBy: req.user._id,
        changeDescription: `Restored to version ${version.versionNumber}`
      });
      await restoredVersion.save();

      // Log activity
      await logActivity(req.user._id, 'version_restored', file._id, null, `Restored to version ${version.versionNumber}`);

      res.json(file);
    } else {
      res.status(404).json({ message: 'Version file not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get file activity
router.get('/activity/:id', auth, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file || file.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'File not found' });
    }

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
    const folder = await Folder.findById(req.params.id);
    if (!folder || folder.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'Folder not found' });
    }

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
    const file = await File.findById(req.params.id);
    if (!file || file.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'File not found' });
    }

    const textExtractor = require('../services/textExtractor');
    if (!textExtractor.isSupported(file.mimeType, file.originalName)) {
      return res.status(400).json({ 
        message: 'Text extraction not supported for this file type'
      });
    }

    const extraction = await documentProcessingService.ensureExtraction(file, { force: false });
    const extractedText = extraction.text || '';
    const fileContent =
      extraction.fileContent ||
      (await FileContent.findOne({ file: file._id }).select('editorHtml extractionMethod'));
    
    if (!extractedText || extractedText.trim().length === 0) {
      const mimeType = file.mimeType.toLowerCase();
      const isWordDoc = mimeType.includes('word') ||
        mimeType.includes('document') ||
        mimeType.includes('msword') ||
        mimeType.includes('vnd.openxmlformats-officedocument.wordprocessingml');

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
        message: extraction.error || 'No text could be extracted from this file. The file may be empty, corrupted, or in an unsupported format.'
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

    res.json({
      text: extractedText,
      textLength: extractedText.length,
      extractionMethod: extraction.extractionMethod || extraction.fileContent?.extractionMethod || '',
      editorHtml: fileContent?.editorHtml || '',
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
    const file = await File.findById(req.params.id);
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check ownership
    if (file.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You do not have permission to edit this file' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    // Create a new version before updating
    const newVersion = new FileVersion({
      file: file._id,
      version: file.version || 1,
      path: file.path,
      size: file.size,
      createdAt: file.updatedAt || file.createdAt,
    });
    await newVersion.save();

    // Delete old file
    if (await fs.pathExists(file.path)) {
      await fs.remove(file.path);
    }

    // Update file record
    file.path = req.file.path;
    file.size = req.file.size;
    file.version = (file.version || 0) + 1;
    file.updatedAt = new Date();
    if (req.file.originalname) {
      file.originalName = req.file.originalname;
    }
    await file.save();

    await documentProcessingService.queueFileProcessing(file, {
      force: true,
    });

    // Log activity
    await logActivity(req.user._id, 'edited', file._id, null, `Updated ${file.originalName}`);

    // Emit real-time update
    const io = req.app.get('io');
    io.to(`user-${req.user._id}`).emit('file-updated', file);

    res.json(file);
  } catch (error) {
    console.error('Error updating file:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update DOCX file from text content
router.put('/update-docx/:id', auth, async (req, res) => {
  try {
    const { text, html, fileName } = req.body;
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check ownership
    if (file.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You do not have permission to edit this file' });
    }

    const fs = require('fs-extra');
    const path = require('path');
    const editorHtml = typeof html === 'string' && html.trim().length > 0 ? html : createHtmlFromText(text || '');
    const plainText =
      typeof text === 'string' && text.trim().length > 0 ? text : htmlToPlainText(editorHtml);

    // Create a new version before updating
    const newVersion = new FileVersion({
      file: file._id,
      version: file.version || 1,
      path: file.path,
      size: file.size,
      createdAt: file.updatedAt || file.createdAt,
    });
    await newVersion.save();

    // Generate DOCX buffer from the richer HTML editor model when available.
    const buffer = await buildDocxBufferFromHtml(editorHtml);

    // Delete old file
    if (await fs.pathExists(file.path)) {
      await fs.remove(file.path);
    }

    // Save new file
    const userId = req.user._id.toString();
    const uploadPath = path.join(__dirname, '..', 'uploads', userId);
    await fs.ensureDir(uploadPath);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const newPath = path.join(uploadPath, uniqueSuffix + '.docx');
    await fs.writeFile(newPath, buffer);

    // Update file record
    file.path = newPath;
    file.size = buffer.length;
    file.version = (file.version || 0) + 1;
    file.updatedAt = new Date();
    if (fileName) {
      file.originalName = fileName.endsWith('.docx') ? fileName : fileName + '.docx';
    }
    await file.save();

    await FileContent.findOneAndUpdate(
      { file: file._id },
      {
        $set: {
          extractedText: plainText,
          extractedAt: new Date(),
          extractionMethod: 'editor-rich-docx',
          extractionStatus: 'completed',
          editorHtml,
          editorUpdatedAt: new Date(),
        },
        $setOnInsert: {
          file: file._id,
        },
      },
      { upsert: true },
    );

    await documentProcessingService.queueFileProcessing(file, {
      force: true,
    });

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
    const { text, html, fileName } = req.body;
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // Check ownership
    if (file.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You do not have permission to edit this file' });
    }

    const fs = require('fs-extra');
    const path = require('path');
    const editorHtml = typeof html === 'string' && html.trim().length > 0 ? html : createHtmlFromText(text || '');
    const plainText =
      typeof text === 'string' && text.trim().length > 0 ? text : htmlToPlainText(editorHtml);
    const pdfBytes = await buildPdfBytesFromHtml(editorHtml);

    // Delete old file
    if (await fs.pathExists(file.path)) {
      await fs.remove(file.path);
    }

    // Save new file
    const userId = req.user._id.toString();
    const uploadPath = path.join(__dirname, '..', 'uploads', userId);
    await fs.ensureDir(uploadPath);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const newPath = path.join(uploadPath, uniqueSuffix + '.pdf');
    await fs.writeFile(newPath, pdfBytes);

    // Update file record
    file.path = newPath;
    file.size = pdfBytes.length;
    file.version = (file.version || 0) + 1;
    file.updatedAt = new Date();
    if (fileName) {
      file.originalName = fileName.endsWith('.pdf') ? fileName : fileName + '.pdf';
    }
    await file.save();

    await FileContent.findOneAndUpdate(
      { file: file._id },
      {
        $set: {
          extractedText: plainText,
          extractedAt: new Date(),
          extractionMethod: 'editor-rich-pdf',
          extractionStatus: 'completed',
          editorHtml,
          editorUpdatedAt: new Date(),
        },
        $setOnInsert: {
          file: file._id,
        },
      },
      { upsert: true },
    );

    await documentProcessingService.queueFileProcessing(file, {
      force: true,
    });

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
