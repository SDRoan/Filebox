const express = require('express');
const auth = require('../middleware/auth');
const companion = require('../services/companion');
const { suggestionsFor } = require('../services/companionSuggestions');

const isId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
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

// What Ask File Box noticed about the current file, selection or folder (read-only; rules and stored
// data only, never the AI model). Every id is re-checked for this person inside suggestionsFor.
router.get('/suggestions', auth, async (req, res) => {
  try {
    const fileIds = [...new Set(String(req.query.fileIds || '').split(',').filter(isId))].slice(0, 20);
    const result = await suggestionsFor(req.user._id, {
      fileId: isId(req.query.fileId) ? req.query.fileId : undefined,
      fileIds,
      folderId: isId(req.query.folderId) ? req.query.folderId : undefined,
    });
    res.set('Cache-Control', 'no-store').json(result);
  } catch (error) {
    console.error('[Ask File Box] Suggestions failed:', error.message);
    res.status(500).json({ message: 'Could not check for suggestions.', suggestions: [] });
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
