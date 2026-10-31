const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const CloudBackup = require('../models/CloudBackup');
const cloudBackupService = require('../services/cloudBackup');

// Folder Sync (see services/cloudBackup.js). Every route works only on the signed-in account's syncs.

const sendError = (res, error, fallback) => res.status(error.status || 500).json({ message: error.message || fallback });

router.get('/', auth, async (req, res) => {
  try {
    res.json(await cloudBackupService.getUserBackups(req.user._id));
  } catch (error) {
    sendError(res, error, 'Could not load your synced folders.');
  }
});

// Desktop / Documents, if they may be synced, plus the approved roots (for the page's hint).
router.get('/default-paths', auth, async (req, res) => {
  try {
    const paths = cloudBackupService.getDefaultBackupPaths();
    const available = {};
    for (const [key, folder] of Object.entries(paths)) {
      available[key] = { path: folder, exists: await cloudBackupService.checkPathExists(folder) };
    }
    res.json({ ...available, enabled: cloudBackupService.isEnabled(), roots: cloudBackupService.approvedRoots() });
  } catch (error) {
    sendError(res, error, 'Could not check your folders.');
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { sourceType, sourcePath, enabled, backupFrequency } = req.body;
    if (!['desktop', 'documents', 'custom'].includes(sourceType) || !sourcePath) {
      return res.status(400).json({ message: 'Choose a folder to sync.' });
    }
    res.json(await cloudBackupService.createOrUpdateBackup(req.user._id, sourceType, sourcePath, { enabled, backupFrequency }));
  } catch (error) {
    sendError(res, error, 'Could not save this sync.');
  }
});

// Sync now: starts in the background and answers right away; the page shows progress.
router.post('/:backupId/backup', auth, async (req, res) => {
  try {
    const backup = await cloudBackupService.startBackup(req.params.backupId, req.user._id);
    res.status(202).json(backup);
  } catch (error) {
    sendError(res, error, 'Could not start syncing.');
  }
});

router.put('/:backupId', auth, async (req, res) => {
  try {
    const { enabled, backupFrequency } = req.body;
    const backup = await CloudBackup.findOne({ _id: req.params.backupId, user: req.user._id });
    if (!backup) return res.status(404).json({ message: 'Sync not found.' });
    if (enabled !== undefined) backup.enabled = Boolean(enabled);
    if (['hourly', 'daily', 'weekly'].includes(backupFrequency)) backup.backupFrequency = backupFrequency;
    backup.updatedAt = new Date();
    res.json(await backup.save());
  } catch (error) {
    sendError(res, error, 'Could not update this sync.');
  }
});

router.delete('/:backupId', auth, async (req, res) => {
  try {
    await cloudBackupService.deleteBackup(req.params.backupId, req.user._id);
    res.json({ message: 'Stopped syncing this folder. Files already copied stay in File Box.' });
  } catch (error) {
    sendError(res, error, 'Could not remove this sync.');
  }
});

module.exports = router;
