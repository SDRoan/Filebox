const express = require('express');
const auth = require('../middleware/auth');
const { authorizeFile, sendDenied } = require('../services/permissions');
const { logFocus } = require('../services/activityLog');

const router = express.Router();

// Heartbeat while a file is open and visible in File Box (preview or editor), so Home can say how long
// was spent on what. Only files the person may read; nothing outside File Box is recorded.
router.post('/focus', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.body?.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    await logFocus(req.user._id, access.file, req.body?.seconds);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Could not record activity.' });
  }
});

module.exports = router;
