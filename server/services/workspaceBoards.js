const crypto = require('crypto');
const WorkspaceTab = require('../models/WorkspaceTab');

/**
 * Boards: a person's tabbed workspace. Every value that reaches the database is checked here; nothing
 * the browser sends is stored as it came. Tabs belong to one person and are only ever looked up together
 * with that person's id, so another person's tab looks exactly like one that does not exist.
 */

const LIMITS = Object.freeze({
  tabs: 30,
  blocksPerTab: 150,
  tabName: 40,
  noteTitle: 80,
  noteBody: 4000,
  richTextChars: 50000,
  richTextBytes: 100 * 1024,
  tabBytes: 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
});
const COLORS = Object.freeze(['sage', 'sky', 'lavender', 'rose', 'amber', 'mint', 'coral', 'slate', 'sand', 'teal']);
const TAB_ID = /^[a-z0-9]{10}$/;
const DEFAULT_TAB_NAME = 'My board';
// Control characters, zero-width and direction-changing characters: never part of a tab name.
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

class BoardInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const newTabId = () => {
  let id = '';
  while (id.length < 10) id += crypto.randomBytes(8).toString('base64').replace(/[^a-z0-9]/g, '');
  return id.slice(0, 10);
};

/** A tab name: trimmed, single spaces, no control characters, 1–40 characters. */
function cleanName(value) {
  if (typeof value !== 'string') throw new BoardInputError('Give the tab a name.');
  // Tabs and new lines become spaces first; then anything invisible is removed.
  const name = value.replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ +/g, ' ').trim();
  if (!name) throw new BoardInputError('Give the tab a name.');
  if ([...name].length > LIMITS.tabName) throw new BoardInputError(`Tab names can be up to ${LIMITS.tabName} characters.`);
  return name;
}

/** One emoji (a single grapheme that is a pictograph), or none. */
function cleanIcon(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 16) throw new BoardInputError('Choose one emoji for the tab.');
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value.trim())];
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(graphemes[0].segment)) {
    throw new BoardInputError('Choose one emoji for the tab.');
  }
  return graphemes[0].segment;
}

function cleanColor(value) {
  if (value === undefined || value === null || value === '') return '';
  if (!COLORS.includes(value)) throw new BoardInputError('Choose one of the tab colors.');
  return value;
}

const tabBytes = (tab) => Buffer.byteLength(JSON.stringify({ name: tab.name, icon: tab.icon, color: tab.color, blocks: tab.blocks || [] }), 'utf8');

/** What the browser is sent about a tab. */
const publicTab = (tab) => ({
  id: tab.tabId,
  name: tab.name,
  icon: tab.icon || '',
  color: tab.color || '',
  order: tab.order,
  isDefault: Boolean(tab.isDefault),
  rev: tab.rev,
  blocks: [],
  blockCount: (tab.blocks || []).length,
  updatedAt: tab.updatedAt,
});

/** Exactly one tab is the default: the stored one, else the first. Fixes the data if needed. */
async function settleDefault(userId, tabs) {
  if (!tabs.length) return tabs;
  const defaults = tabs.filter(t => t.isDefault);
  if (defaults.length === 1) return tabs;
  const keep = defaults[0] || tabs[0];
  await WorkspaceTab.updateMany({ user: userId, tabId: { $ne: keep.tabId } }, { $set: { isDefault: false } });
  await WorkspaceTab.updateOne({ user: userId, tabId: keep.tabId }, { $set: { isDefault: true } });
  return tabs.map(t => ({ ...t, isDefault: t.tabId === keep.tabId }));
}

async function createTabRecord(userId, { name, icon = '', color = '', isDefault = false }, existing) {
  const order = existing.length ? Math.max(...existing.map(t => t.order)) + 1 : 0;
  const record = { user: userId, tabId: newTabId(), name, icon, color, order, isDefault, rev: 0, blocks: [] };
  record.bytes = tabBytes(record);
  const total = existing.reduce((sum, t) => sum + (t.bytes || 0), 0);
  if (total + record.bytes > LIMITS.totalBytes) throw new BoardInputError('Your Boards are full. Remove something to add more.', 413);
  const created = await WorkspaceTab.create(record);
  return created.toObject();
}

/** Every tab of this person, in order. Someone with no tabs yet gets one empty default tab. */
async function listTabs(userId) {
  let tabs = await WorkspaceTab.find({ user: userId }).sort({ order: 1, createdAt: 1 }).lean();
  if (!tabs.length) tabs = [await createTabRecord(userId, { name: DEFAULT_TAB_NAME, isDefault: true }, [])];
  tabs = await settleDefault(userId, tabs);
  return tabs.map(publicTab);
}

async function createTab(userId, body = {}) {
  const name = cleanName(body.name);
  const icon = cleanIcon(body.icon);
  const color = cleanColor(body.color);
  const existing = await WorkspaceTab.find({ user: userId }).select('tabId order bytes isDefault').lean();
  if (existing.length >= LIMITS.tabs) throw new BoardInputError(`You can have up to ${LIMITS.tabs} tabs.`, 409);
  const tab = await createTabRecord(userId, { name, icon, color, isDefault: !existing.length }, existing);
  return publicTab(tab);
}

/**
 * Rename a tab (and later: icon and color). `rev` must be the revision the browser last saw; if the tab
 * changed since (another device), nothing is saved and the current tab is returned with a 409.
 */
async function updateTab(userId, tabId, body = {}) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const changes = {};
  if (body.name !== undefined) changes.name = cleanName(body.name);
  if (body.icon !== undefined) changes.icon = cleanIcon(body.icon);
  if (body.color !== undefined) changes.color = cleanColor(body.color);
  if (!Object.keys(changes).length) throw new BoardInputError('Nothing to change.');
  if (!Number.isInteger(body.rev) || body.rev < 0) throw new BoardInputError('Missing tab revision.');

  const current = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!current) throw new BoardInputError('Tab not found.', 404);
  const bytes = tabBytes({ ...current, ...changes });
  if (bytes > LIMITS.tabBytes) throw new BoardInputError('This tab is too large to save.', 413);
  const updated = await WorkspaceTab.findOneAndUpdate(
    { user: userId, tabId, rev: body.rev },
    { $set: { ...changes, bytes }, $inc: { rev: 1 } },
    { new: true }
  ).lean();
  if (!updated) {
    const latest = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
    if (!latest) throw new BoardInputError('Tab not found.', 404);
    const error = new BoardInputError('This tab was changed somewhere else. Showing the latest version.', 409);
    error.tab = publicTab(latest);
    throw error;
  }
  return publicTab(updated);
}

/**
 * Delete a tab: only the tab and its layout. Files and folders it pointed at are untouched. If it was the
 * default, the first remaining tab becomes the default; if it was the last tab, a new empty one is made.
 */
async function deleteTab(userId, tabId) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const removed = await WorkspaceTab.findOneAndDelete({ user: userId, tabId }).lean();
  if (!removed) throw new BoardInputError('Tab not found.', 404);
  const tabs = await listTabs(userId);
  return { tabs, deleted: tabId };
}

module.exports = { LIMITS, COLORS, BoardInputError, cleanName, cleanIcon, cleanColor, listTabs, createTab, updateTab, deleteTab, DEFAULT_TAB_NAME };
