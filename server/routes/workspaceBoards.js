const express = require('express');
const auth = require('../middleware/auth');
const boards = require('../services/workspaceBoards');
const router = express.Router();

// Boards (/boards): each person's own tabs. Every route works only on the signed-in person's tabs.

const fail = (res, error) => {
  if (error instanceof boards.BoardInputError) {
    return res.status(error.status).json({ message: error.message, ...(error.tab ? { tab: error.tab } : {}), ...(error.blocks ? { blocks: error.blocks } : {}), ...(error.zones ? { zones: error.zones } : {}), ...(error.tabs ? { tabs: error.tabs } : {}) });
  }
  console.error('Boards error:', error);
  return res.status(500).json({ message: 'Boards are not available right now.' });
};

router.get('/', auth, async (req, res) => {
  try {
    res.json({ tabs: await boards.listTabs(req.user._id), limits: boards.LIMITS, colors: boards.COLORS, noteColors: boards.NOTE_COLORS, sizes: boards.SIZES });
  } catch (error) { fail(res, error); }
});

router.post('/tabs', auth, async (req, res) => {
  try {
    res.status(201).json({ tab: await boards.createTab(req.user._id, req.body) });
  } catch (error) { fail(res, error); }
});

// The order of all tabs (only order changes; no tab's revision moves).
router.put('/tabs/order', auth, async (req, res) => {
  try {
    res.json({ tabs: await boards.reorderTabs(req.user._id, req.body) });
  } catch (error) { fail(res, error); }
});

// Which of the person's own tabs already hold a file or folder (?fileId= or ?folderId=).
router.get('/placements', auth, async (req, res) => {
  try {
    res.json(await boards.placements(req.user._id, req.query));
  } catch (error) { fail(res, error); }
});

router.post('/tabs/:tabId/duplicate', auth, async (req, res) => {
  try {
    res.status(201).json(await boards.duplicateTab(req.user._id, req.params.tabId));
  } catch (error) { fail(res, error); }
});

router.post('/tabs/:tabId/default', auth, async (req, res) => {
  try {
    res.json({ tabs: await boards.setDefaultTab(req.user._id, req.params.tabId) });
  } catch (error) { fail(res, error); }
});

// "Add to board" from a file or folder menu: { type: 'file' | 'folder', id }.
router.post('/tabs/:tabId/refs', auth, async (req, res) => {
  try {
    res.json(await boards.addRef(req.user._id, req.params.tabId, req.body));
  } catch (error) { fail(res, error); }
});

// Saved searches: run the named blocks' stored filters through Advanced Search (current access, nothing stored).
router.post('/tabs/:tabId/searches/run', auth, async (req, res) => {
  try {
    res.json(await boards.runTabSearches(req.user._id, req.params.tabId, req.body));
  } catch (error) { fail(res, error); }
});

// "Save to board…" from Advanced Search: a saved-search block with the filters that ran.
router.post('/tabs/:tabId/searches', auth, async (req, res) => {
  try {
    res.status(201).json(await boards.addSearch(req.user._id, req.params.tabId, req.body));
  } catch (error) { fail(res, error); }
});

// One tab with its blocks, each file or folder resolved against what the person can open now.
router.get('/tabs/:tabId', auth, async (req, res) => {
  try {
    res.json(await boards.getTab(req.user._id, req.params.tabId));
  } catch (error) { fail(res, error); }
});

router.put('/tabs/:tabId/blocks', auth, async (req, res) => {
  try {
    res.json(await boards.saveBlocks(req.user._id, req.params.tabId, req.body));
  } catch (error) { fail(res, error); }
});

// The canvas pattern and tone of a tab (presentation only: no revision change).
router.put('/tabs/:tabId/appearance', auth, async (req, res) => {
  try {
    res.json({ tab: await boards.setAppearance(req.user._id, req.params.tabId, req.body) });
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
