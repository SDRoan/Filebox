const express = require('express');
const auth = require('../middleware/auth');
const BoardLayout = require('../models/BoardLayout');
const { coordinate, cleanZones } = require('../utils/boardLayout');
const router = express.Router();

// My Files > Board: each person's own layout for a folder (positions and zones only).

const FOLDER_KEY = /^[a-z0-9-]{1,80}$/;
const ITEM_KEY = /^(file|folder)-[a-f0-9]{24}$/;
const MAX_ITEMS = 2000;

function sanitizeLayout(body) {
  const items = {};
  if (body && body.items && typeof body.items === 'object' && !Array.isArray(body.items)) {
    Object.entries(body.items).slice(0, MAX_ITEMS).forEach(([key, value]) => {
      const x = coordinate(value?.x);
      const y = coordinate(value?.y);
      if (ITEM_KEY.test(key) && x !== null && y !== null) items[key] = { x, y };
    });
  }
  // Zones are checked the same way as on personal Boards (utils/boardLayout.js).
  const zones = cleanZones(body?.zones);
  return { items, zones };
}

router.get('/:folderKey', auth, async (req, res) => {
  if (!FOLDER_KEY.test(req.params.folderKey)) return res.status(400).json({ message: 'Unknown folder.' });
  try {
    const layout = await BoardLayout.findOne({ user: req.user._id, folderKey: req.params.folderKey }).lean();
    res.json({ items: layout?.items || {}, zones: layout?.zones || [] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:folderKey', auth, async (req, res) => {
  if (!FOLDER_KEY.test(req.params.folderKey)) return res.status(400).json({ message: 'Unknown folder.' });
  try {
    const layout = sanitizeLayout(req.body);
    await BoardLayout.updateOne(
      { user: req.user._id, folderKey: req.params.folderKey },
      { $set: layout },
      { upsert: true },
    );
    res.json(layout);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
