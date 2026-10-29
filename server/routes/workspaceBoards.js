const express = require('express');
const auth = require('../middleware/auth');
const boards = require('../services/workspaceBoards');
const router = express.Router();

// Boards (/boards): each person's own tabs. Every route works only on the signed-in person's tabs.

const fail = (res, error) => {
  if (error instanceof boards.BoardInputError) {
    return res.status(error.status).json({ message: error.message, ...(error.tab ? { tab: error.tab } : {}) });
  }
  console.error('Boards error:', error);
  return res.status(500).json({ message: 'Boards are not available right now.' });
};

router.get('/', auth, async (req, res) => {
  try {
    res.json({ tabs: await boards.listTabs(req.user._id), limits: boards.LIMITS, colors: boards.COLORS });
  } catch (error) { fail(res, error); }
});

router.post('/tabs', auth, async (req, res) => {
  try {
    res.status(201).json({ tab: await boards.createTab(req.user._id, req.body) });
  } catch (error) { fail(res, error); }
});

router.patch('/tabs/:tabId', auth, async (req, res) => {
  try {
    res.json({ tab: await boards.updateTab(req.user._id, req.params.tabId, req.body) });
  } catch (error) { fail(res, error); }
});

router.delete('/tabs/:tabId', auth, async (req, res) => {
  try {
    res.json(await boards.deleteTab(req.user._id, req.params.tabId));
  } catch (error) { fail(res, error); }
});

module.exports = router;
