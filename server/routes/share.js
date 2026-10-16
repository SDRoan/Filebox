const express = require('express');
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const Share = require('../models/Share');
const File = require('../models/File');
const User = require('../models/User');
const FileActivity = require('../models/FileActivity');
const analytics = require('../services/analytics');
const { authorizeFile, sendDenied, isActiveShare } = require('../services/permissions');
const router = express.Router();

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const PERMISSIONS = ['view', 'edit'];

// Shares made before passwords were hashed still store them in plain text.
const passwordMatches = async (share, password) => {
  if (!share.password) return true;
  if (!password) return false;
  return BCRYPT_HASH.test(share.password)
    ? bcrypt.compare(String(password), share.password)
    : share.password === String(password);
};

const linkSummary = (share) => ({
  shareId: share.shareId,
  url: `/s/${share.shareId}`,
  accessType: 'view',
  hasPassword: Boolean(share.password),
  allowDownload: share.allowDownload !== false,
  expiresAt: share.expiresAt,
  expired: Boolean(share.expiresAt && new Date() > share.expiresAt),
  downloadCount: share.downloadCount,
  createdAt: share.createdAt,
});

// A share entry's ObjectId records when it was added.
const sharedAtOf = (entry) => (entry?._id?.getTimestamp ? entry._id.getTimestamp() : null);

const parseExpiry = (value) => {
  if (!value) return { date: null };
  const date = new Date(value);
  if (isNaN(date.getTime())) return { error: 'Invalid expiration date' };
  if (date <= new Date()) return { error: 'Expiration date must be in the future' };
  return { date };
};

/** Load a public link and its file; answers 404/410 itself when the link can't be used. */
async function loadUsableShare(shareId, res) {
  const share = await Share.findOne({ shareId }).populate('file').populate('owner', 'name');
  if (!share || !share.file || share.file.isTrashed) {
    res.status(404).json({ message: 'This link does not exist or the file was removed' });
    return null;
  }
  if (share.expiresAt && new Date() > share.expiresAt) {
    res.status(410).json({ message: 'This link has expired' });
    return null;
  }
  return share;
}

// Who has access to a file, and its links (owner only)
router.get('/file/:fileId', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'owner');
    if (sendDenied(res, access)) return;
    const file = await access.file.populate([{ path: 'owner', select: 'name email' }, { path: 'sharedWith.user', select: 'name email' }]);
    const links = await Share.find({ file: file._id }).sort({ createdAt: -1 });

    res.json({
      file: { _id: file._id, originalName: file.originalName, mimeType: file.mimeType },
      owner: { _id: file.owner._id, name: file.owner.name, email: file.owner.email },
      people: file.sharedWith
        .filter(entry => entry.user)
        .map(entry => ({
          user: { _id: entry.user._id, name: entry.user.name, email: entry.user.email },
          permission: entry.permission,
          expiresAt: entry.expiresAt,
          expired: !isActiveShare(entry),
          sharedAt: sharedAtOf(entry),
        })),
      links: links.map(linkSummary),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create a public link (owner only). Links are view-only; downloads can be turned off.
router.post('/create', auth, async (req, res) => {
  try {
    const { fileId, password, expiresAt, allowDownload } = req.body;
    const access = await authorizeFile(fileId, req.user._id, 'owner');
    if (sendDenied(res, access)) return;

    const expiry = parseExpiry(expiresAt);
    if (expiry.error) return res.status(400).json({ message: expiry.error });

    const share = await Share.create({
      file: access.file._id,
      owner: req.user._id,
      accessType: 'view',
      allowDownload: allowDownload !== false,
      password: password ? await bcrypt.hash(String(password), 10) : null,
      expiresAt: expiry.date,
    });

    res.status(201).json({ _id: share._id, ...linkSummary(share), file: access.file._id });
  } catch (error) {
    console.error('[Share] Error creating share:', error);
    res.status(500).json({ message: error.message });
  }
});

// Add a person, or change their permission (owner only). Accepts an exact email or a userId.
router.post('/user', auth, async (req, res) => {
  try {
    const { fileId, userId, email, permission = 'view', expiresAt } = req.body;
    if (!PERMISSIONS.includes(permission)) return res.status(400).json({ message: 'Permission must be view or edit' });

    const access = await authorizeFile(fileId, req.user._id, 'owner');
    if (sendDenied(res, access)) return;
    const { file } = access;

    const userToShare = email
      ? await User.findOne({ email: String(email).trim().toLowerCase() }).select('name email')
      : await User.findById(userId).select('name email').catch(() => null);
    if (!userToShare) {
      return res.status(404).json({ message: 'No File Box account uses that email' });
    }
    if (userToShare._id.equals(req.user._id)) {
      return res.status(400).json({ message: 'You already own this file' });
    }

    const expiry = parseExpiry(expiresAt);
    if (expiry.error) return res.status(400).json({ message: expiry.error });

    const existing = file.sharedWith.find(entry => entry.user?.toString() === userToShare._id.toString());
    if (existing) {
      existing.permission = permission;
      if (expiresAt !== undefined) existing.expiresAt = expiry.date;
    } else {
      file.sharedWith.push({ user: userToShare._id, permission, expiresAt: expiry.date });
    }
    await file.save();

    await analytics.recordActivity(file._id, req.user._id, 'share', { sharedWith: userToShare._id, permission });

    const io = req.app.get('io');
    if (io && !existing) {
      io.to(`user-${userToShare._id}`).emit('file-shared-with-you', {
        file: { _id: file._id, originalName: file.originalName, mimeType: file.mimeType, size: file.size },
        sharedBy: { _id: req.user._id, name: req.user.name, email: req.user.email },
        permission,
        timestamp: new Date(),
      });
    }

    res.json({
      message: existing ? 'Permission updated' : 'File shared successfully',
      person: { user: { _id: userToShare._id, name: userToShare.name, email: userToShare.email }, permission },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Remove someone's access. The owner can remove anyone; a recipient can remove themselves.
router.delete('/user/:fileId/:userId', auth, async (req, res) => {
  try {
    const leaving = req.params.userId === req.user._id.toString();
    const access = await authorizeFile(req.params.fileId, req.user._id, leaving ? 'viewer' : 'owner');
    if (sendDenied(res, access)) return;
    const { file } = access;

    const before = file.sharedWith.length;
    file.sharedWith = file.sharedWith.filter(entry => entry.user?.toString() !== req.params.userId);
    if (file.sharedWith.length === before) return res.status(404).json({ message: 'That person does not have access' });
    await file.save();

    req.app.get('io')?.to(`user-${req.params.userId}`).emit('file-unshared', { fileId: file._id });
    res.json({ message: leaving ? 'Removed from your shared files' : 'Access removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Files shared with me (active shares only). Other recipients and server paths are not exposed.
router.get('/shared/with-me', auth, async (req, res) => {
  try {
    const files = await File.find({
      sharedWith: { $elemMatch: { user: req.user._id, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] } },
      isTrashed: { $ne: true },
    }).populate('owner', 'name email');

    const result = files.map(file => {
      const entry = file.sharedWith.find(s => s.user?.toString() === req.user._id.toString());
      const { path, sharedWith, accessLog, ...safe } = file.toObject();
      return {
        ...safe,
        sharePermission: entry?.permission || 'view',
        access: entry?.permission === 'edit' ? 'editor' : 'viewer',
        sharedAt: sharedAtOf(entry) || file.createdAt,
      };
    }).sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Files I have shared with people or through links
router.get('/shared/by-me', auth, async (req, res) => {
  try {
    const linkedIds = await Share.distinct('file', { owner: req.user._id });
    const files = await File.find({
      owner: req.user._id,
      isTrashed: { $ne: true },
      $or: [{ 'sharedWith.0': { $exists: true } }, { _id: { $in: linkedIds } }],
    }).populate('sharedWith.user', 'name email');

    const linkCounts = await Share.aggregate([
      { $match: { file: { $in: files.map(f => f._id) } } },
      { $group: { _id: '$file', count: { $sum: 1 }, latest: { $max: '$createdAt' } } },
    ]);
    const links = new Map(linkCounts.map(l => [l._id.toString(), l]));

    const result = files.map(file => {
      const { path, accessLog, ...safe } = file.toObject();
      const link = links.get(file._id.toString());
      const dates = [...file.sharedWith.map(sharedAtOf), link?.latest].filter(Boolean);
      return {
        ...safe,
        linkCount: link?.count || 0,
        sharedAt: dates.length ? new Date(Math.max(...dates.map(d => new Date(d)))) : file.updatedAt,
      };
    }).sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get activity for a shared file (who accessed it, when)
router.get('/activity/:fileId', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;

    // Get activity for this file
    const activities = await FileActivity.find({ file: req.params.fileId })
      .populate('user', 'name email')
      .sort({ timestamp: -1 })
      .limit(50);

    res.json(activities);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get access statistics for files you've shared
router.get('/shared/by-me/stats', auth, async (req, res) => {
  try {
    const files = await File.find({
      owner: req.user._id,
      'sharedWith.0': { $exists: true },
      isTrashed: false
    });

    const fileIds = files.map(f => f._id);
    
    // Get activity stats for all shared files
    const stats = await FileActivity.aggregate([
      {
        $match: {
          file: { $in: fileIds },
          action: { $in: ['view', 'download', 'preview'] }
        }
      },
      {
        $group: {
          _id: '$file',
          viewCount: {
            $sum: { $cond: [{ $eq: ['$action', 'view'] }, 1, 0] }
          },
          downloadCount: {
            $sum: { $cond: [{ $eq: ['$action', 'download'] }, 1, 0] }
          },
          previewCount: {
            $sum: { $cond: [{ $eq: ['$action', 'preview'] }, 1, 0] }
          },
          lastAccessed: { $max: '$timestamp' },
          uniqueUsers: { $addToSet: '$user' }
        }
      },
      {
        $project: {
          fileId: '$_id',
          viewCount: 1,
          downloadCount: 1,
          previewCount: 1,
          totalAccess: { $add: ['$viewCount', '$downloadCount', '$previewCount'] },
          lastAccessed: 1,
          uniqueUserCount: { $size: '$uniqueUsers' }
        }
      }
    ]);

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Public: what a link points to. Never exposes paths, other recipients, or the password.
router.get('/:shareId', async (req, res) => {
  try {
    const share = await loadUsableShare(req.params.shareId, res);
    if (!share) return;
    res.json({
      shareId: share.shareId,
      file: { originalName: share.file.originalName, size: share.file.size, mimeType: share.file.mimeType },
      owner: { name: share.owner?.name || 'A File Box user' },
      requiresPassword: Boolean(share.password),
      allowDownload: share.allowDownload !== false,
      expiresAt: share.expiresAt,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Public: download through a link
router.get('/:shareId/download', async (req, res) => {
  try {
    const share = await loadUsableShare(req.params.shareId, res);
    if (!share) return;

    if (!(await passwordMatches(share, req.query.password))) {
      return res.status(401).json({ message: 'Incorrect password' });
    }
    if (share.allowDownload === false) {
      return res.status(403).json({ message: 'Downloads are turned off for this link' });
    }

    const fs = require('fs-extra');
    if (!await fs.pathExists(share.file.path)) {
      return res.status(404).json({ message: 'File not found on disk' });
    }

    await Share.updateOne({ _id: share._id }, { $inc: { downloadCount: 1 } });
    res.download(share.file.path, share.file.originalName);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Remove a link (owner only)
router.delete('/:shareId', auth, async (req, res) => {
  try {
    const share = await Share.findOne({ shareId: req.params.shareId });
    if (!share || share.owner.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'Share not found' });
    }
    await share.deleteOne();
    res.json({ message: 'Link removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
