const express = require('express');
const auth = require('../middleware/auth');
const { buildHome } = require('../services/homeSummary');
const { dayFacts, recentDays, startSummary, isWriting, cachedSummary, localDate } = require('../services/dailySummary');
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

const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const tzOf = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 0;
};

// "Your day": what the person did in File Box on a date (default today, in their time zone), the summary
// File Box AI already wrote for it if still current, and the recent days that have activity.
router.get('/day', auth, async (req, res) => {
  try {
    const tz = tzOf(req.query.tz);
    const date = validDate(req.query.date) ? req.query.date : localDate(new Date(), tz);
    const facts = await dayFacts(req.user._id, date, tz);
    res.set('Cache-Control', 'no-store').json({
      facts,
      summary: await cachedSummary(req.user._id, facts),
      writing: isWriting(req.user._id, date),
      days: await recentDays(req.user._id, tz),
    });
  } catch (error) {
    console.error('[Home] Could not build the day:', error);
    res.status(500).json({ message: 'Could not load your day.' });
  }
});

// Write File Box AI's summary of a day in the background (local model; plain sentences when it is not
// running). Home checks GET /day until it appears. `wait: true` answers with the summary instead.
router.post('/day/summary', auth, async (req, res) => {
  try {
    const tz = tzOf(req.body?.tz);
    const date = validDate(req.body?.date) ? req.body.date : localDate(new Date(), tz);
    const facts = await dayFacts(req.user._id, date, tz);
    const job = startSummary(req.user._id, facts, { force: req.body?.force === true });
    if (req.body?.wait === true) return res.json(await job);
    res.status(202).json({ writing: true });
  } catch (error) {
    console.error('[Home] Could not write the day summary:', error);
    res.status(500).json({ message: 'Could not write the summary.' });
  }
});

module.exports = router;
