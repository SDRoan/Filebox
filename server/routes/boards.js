const express = require('express');
const auth = require('../middleware/auth');
const BoardLayout = require('../models/BoardLayout');
const router = express.Router();

// My Files > Board: each person's own layout for a folder (positions and zones only).

const FOLDER_KEY = /^[a-z0-9-]{1,80}$/;
const ITEM_KEY = /^(file|folder)-[a-f0-9]{24}$/;
const SHAPES = ['rectangle', 'rounded', 'circle', 'pill'];
const MAX_ITEMS = 2000;
const MAX_ZONES = 100;
const CANVAS = 20000;

const coordinate = (value, max = CANVAS) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(0, value))) : null);

function sanitizeLayout(body) {
  const items = {};
  if (body && body.items && typeof body.items === 'object' && !Array.isArray(body.items)) {
    Object.entries(body.items).slice(0, MAX_ITEMS).forEach(([key, value]) => {
      const x = coordinate(value?.x);
      const y = coordinate(value?.y);
      if (ITEM_KEY.test(key) && x !== null && y !== null) items[key] = { x, y };
    });
  }
  const zones = (Array.isArray(body?.zones) ? body.zones : []).slice(0, MAX_ZONES).map(zone => {
    const x = coordinate(zone?.x);
    const y = coordinate(zone?.y);
    const w = coordinate(zone?.w, 6000);
    const h = coordinate(zone?.h, 6000);
    if (typeof zone?.id !== 'string' || !/^[a-z0-9]{1,24}$/.test(zone.id) || [x, y, w, h].includes(null)) return null;
    return {
      id: zone.id,
      name: typeof zone.name === 'string' ? zone.name.slice(0, 60) : '',
      color: typeof zone.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(zone.color) ? zone.color.toLowerCase() : '#dbeafe',
      shape: SHAPES.includes(zone.shape) ? zone.shape : 'rounded',
      x, y, w: Math.max(120, w), h: Math.max(90, h),
    };
  }).filter(Boolean);
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
