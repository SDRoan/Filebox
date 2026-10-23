const express = require('express');
const auth = require('../middleware/auth');
const companion = require('../services/companion');
const router = express.Router();

// File Box AI's companion settings and memory (services/companion.js).

router.get('/', auth, async (req, res) => {
  try {
    res.json(companion.publicProfile(await companion.getProfile(req.user._id)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/', auth, async (req, res) => {
  try {
    res.json(await companion.updateSettings(req.user._id, req.body));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/memories', auth, async (req, res) => {
  try {
    const profile = await companion.addMemory(req.user._id, req.body?.text);
    if (!profile) return res.status(400).json({ message: 'Write something to remember.' });
    res.json(profile);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/memories/:id', auth, async (req, res) => {
  if (!/^[a-f0-9]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Unknown memory.' });
  try {
    res.json(await companion.removeMemory(req.user._id, req.params.id));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/memories', auth, async (req, res) => {
  try {
    res.json(await companion.clearMemories(req.user._id));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
