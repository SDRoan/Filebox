const express = require('express');
const auth = require('../middleware/auth');
const { buildHome } = require('../services/homeSummary');
const router = express.Router();

// Home overview: continue working, up to 3 suggestions, recent activity. Local data only; never calls Ollama.
router.get('/', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await buildHome(req.user._id));
  } catch (error) {
    console.error('[Home] Could not build overview:', error);
    res.status(500).json({ message: 'Could not load your Home overview.' });
  }
});

module.exports = router;
