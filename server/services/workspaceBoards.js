const crypto = require('crypto');
const mongoose = require('mongoose');
const WorkspaceTab = require('../models/WorkspaceTab');
const File = require('../models/File');
const Folder = require('../models/Folder');
const TeamFolder = require('../models/TeamFolder');
const FileContent = require('../models/FileContent');
const User = require('../models/User');
const grid = require('../utils/boardGrid');
const { effectiveClassification } = require('./fileClassifier');
const { technicalType } = require('./advancedSearch');

/**
 * Boards: a person's tabbed workspace. Every value that reaches the database is checked here; nothing
 * the browser sends is stored as it came. Tabs belong to one person and are only ever looked up together
 * with that person's id, so another person's tab looks exactly like one that does not exist.
 *
 * File and folder blocks are references only (an id). They are resolved against the person's current
 * access every time a tab is loaded; anything they can no longer open comes back as { available: false }
 * with no id, name or other detail. Loading a tab costs a fixed number of queries, whatever its size.
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
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
const BLOCK_ID = /^[a-z0-9]{10}$/;
const BLOCK_TYPES = ['file', 'folder'];
const UNAVAILABLE_TO_ADD = "Something you tried to add isn't available.";

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

// ---- File and folder references

const idOf = (value) => String(value?._id || value || '');
const isActiveShare = (entry) => !entry.expiresAt || new Date(entry.expiresAt) > new Date();

/**
 * Which folders sit inside the person's Team Spaces, and in which Space: one query for their Spaces plus
 * one per level of folders inside them (independent of how many blocks a tab has).
 */
async function teamIndex(userId) {
  const teams = await TeamFolder.find({ $or: [{ owner: userId }, { 'members.user': userId }] }).select('_id name').lean();
  const spaceOf = new Map(teams.map(t => [idOf(t._id), t]));
  let frontier = teams.map(t => t._id);
  for (let depth = 0; frontier.length && depth < 32; depth += 1) {
    const children = await Folder.find({ parentFolder: { $in: frontier }, isTrashed: { $ne: true } }).select('_id parentFolder').lean();
    children.forEach(c => spaceOf.set(idOf(c._id), spaceOf.get(idOf(c.parentFolder))));
    frontier = children.map(c => c._id);
  }
  return spaceOf;
}

/**
 * The current state of every referenced file and folder, for this person, in batched queries:
 * Team Spaces (see teamIndex), files, their classification, owners' names, folders and folder counts.
 * Returns maps id → public reference; ids the person cannot open are simply absent.
 */
async function resolveRefs(userId, fileIds, folderIds, { withDetails = true } = {}) {
  const user = idOf(userId);
  const valid = (ids) => [...new Set(ids)].filter(id => mongoose.isValidObjectId(id));
  const fIds = valid(fileIds);
  const dIds = valid(folderIds);
  const files = new Map();
  const folders = new Map();
  if (!fIds.length && !dIds.length) return { files, folders };
  const spaceOf = await teamIndex(userId);

  if (fIds.length) {
    const found = await File.find({ _id: { $in: fIds } })
      .select('originalName mimeType size owner parentFolder isTrashed isStarred sharedWith updatedAt').lean();
    const readable = found.map((file) => {
      if (file.isTrashed) return null;
      if (idOf(file.owner) === user) return { file, source: 'owned', role: 'owner' };
      const share = (file.sharedWith || []).find(s => idOf(s.user) === user && isActiveShare(s));
      const space = file.parentFolder ? spaceOf.get(idOf(file.parentFolder)) : null;
      if (share) return { file, source: 'shared', role: share.permission === 'edit' ? 'editor' : 'viewer' };
      if (space) return { file, source: 'team', role: 'viewer', teamName: space.name };
      return null;
    }).filter(Boolean);
    let contents = new Map();
    let owners = new Map();
    if (withDetails && readable.length) {
      const [c, o] = await Promise.all([
        FileContent.find({ file: { $in: readable.map(r => r.file._id) } })
          .select('file aiCategory primaryCategory documentType classificationSource topics userClassification').lean(),
        User.find({ _id: { $in: [...new Set(readable.filter(r => r.source !== 'owned').map(r => idOf(r.file.owner)))] } }).select('name').lean(),
      ]);
      contents = new Map(c.map(x => [idOf(x.file), x]));
      owners = new Map(o.map(x => [idOf(x._id), x.name]));
    }
    readable.forEach(({ file, source, role, teamName }) => {
      const cls = withDetails ? effectiveClassification(file, contents.get(idOf(file._id)) || null) : null;
      files.set(idOf(file._id), {
        available: true,
        fileId: idOf(file._id),
        name: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        technicalType: technicalType(file),
        updatedAt: file.updatedAt,
        source,
        role,
        ...(source === 'owned' ? { isStarred: Boolean(file.isStarred), parentFolder: file.parentFolder ? idOf(file.parentFolder) : null } : {}),
        ...(source === 'shared' ? { ownerName: owners.get(idOf(file.owner)) || null } : {}),
        ...(teamName ? { teamName } : {}),
        ...(cls ? { category: cls.primaryCategory, documentType: cls.documentType } : {}),
      });
    });
  }

  if (dIds.length) {
    const found = await Folder.find({ _id: { $in: dIds } }).select('name owner parentFolder isTrashed').lean();
    const readable = found.filter(f => !f.isTrashed && (idOf(f.owner) === user || spaceOf.has(idOf(f._id))));
    let counts = new Map();
    if (withDetails && readable.length) {
      // Files and subfolders directly inside each folder, in one query.
      const ids = readable.map(f => f._id);
      const rows = await Folder.aggregate([
        { $match: { parentFolder: { $in: ids }, isTrashed: { $ne: true } } },
        { $project: { p: '$parentFolder' } },
        { $unionWith: { coll: File.collection.name, pipeline: [{ $match: { parentFolder: { $in: ids }, isTrashed: { $ne: true } } }, { $project: { p: '$parentFolder' } }] } },
        { $group: { _id: '$p', n: { $sum: 1 } } },
      ]);
      counts = new Map(rows.map(r => [idOf(r._id), r.n]));
    }
    readable.forEach((folder) => {
      const owned = idOf(folder.owner) === user;
      const space = spaceOf.get(idOf(folder._id));
      folders.set(idOf(folder._id), {
        available: true,
        folderId: idOf(folder._id),
        name: folder.name,
        source: owned ? 'owned' : 'team',
        ...(!owned && space ? { teamName: space.name } : {}),
        ...(withDetails ? { itemCount: counts.get(idOf(folder._id)) || 0 } : {}),
      });
    });
  }
  return { files, folders };
}

/**
 * The blocks of a tab as the page may see them. A reference the person cannot open now is
 * { available: false } and nothing more: no id, name, owner, folder, size or category.
 */
async function resolveBlocks(userId, blocks) {
  const { files, folders } = await resolveRefs(userId,
    blocks.filter(b => b.type === 'file').map(b => b.fileId),
    blocks.filter(b => b.type === 'folder').map(b => b.folderId));
  return blocks.map((b) => {
    const ref = b.type === 'file' ? files.get(idOf(b.fileId)) : folders.get(idOf(b.folderId));
    return { id: b.id, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h, ref: ref || { available: false } };
  });
}

async function getTab(userId, tabId) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const tab = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!tab) throw new BoardInputError('Tab not found.', 404);
  return { tab: publicTab(tab), blocks: await resolveBlocks(userId, tab.blocks || []) };
}

/**
 * Save a tab's blocks (positions, sizes, adds and removals). The browser's list is only a request:
 *  - an existing block keeps the type and reference stored on the server (ids the browser sends for it are ignored)
 *  - a new block must point at a file or folder the person can open right now
 *  - the same file or folder may not appear twice on one tab
 *  - every position and size is clamped and the layout made overlap-free here
 *  - `rev` must match, so another device's save is never silently overwritten (409 with the latest tab)
 */
async function saveBlocks(userId, tabId, body = {}) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  if (!Number.isInteger(body.rev) || body.rev < 0) throw new BoardInputError('Missing tab revision.');
  if (!Array.isArray(body.blocks)) throw new BoardInputError('Missing blocks.');
  if (body.blocks.length > LIMITS.blocksPerTab) throw new BoardInputError(`A tab can hold up to ${LIMITS.blocksPerTab} items.`);
  const current = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!current) throw new BoardInputError('Tab not found.', 404);
  if (current.rev !== body.rev) throw await conflict(userId, tabId);

  const stored = new Map((current.blocks || []).map(b => [b.id, b]));
  const seenIds = new Set();
  const refs = new Set();
  const added = { file: [], folder: [] };
  const next = body.blocks.map((raw) => {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!BLOCK_ID.test(id) || seenIds.has(id)) throw new BoardInputError('Some blocks could not be saved. Reload and try again.');
    seenIds.add(id);
    let base = stored.get(id);
    if (!base) {
      const type = BLOCK_TYPES.includes(raw.type) ? raw.type : null;
      const refId = type === 'file' ? raw.fileId : type === 'folder' ? raw.folderId : null;
      if (!type || typeof refId !== 'string' || !mongoose.isValidObjectId(refId) || String(new mongoose.Types.ObjectId(refId)) !== refId) {
        throw new BoardInputError(UNAVAILABLE_TO_ADD);
      }
      base = { id, type, ...(type === 'file' ? { fileId: refId } : { folderId: refId }) };
      added[type].push(refId);
    }
    const key = `${base.type}:${idOf(base.type === 'file' ? base.fileId : base.folderId)}`;
    if (refs.has(key)) throw new BoardInputError(`That ${base.type} is already on this tab.`);
    refs.add(key);
    return { ...base, x: raw.x, y: raw.y, w: raw.w, h: raw.h };
  });

  if (added.file.length || added.folder.length) {
    const { files, folders } = await resolveRefs(userId, added.file, added.folder, { withDetails: false });
    if (added.file.some(id => !files.has(id)) || added.folder.some(id => !folders.has(id))) throw new BoardInputError(UNAVAILABLE_TO_ADD);
  }

  const blocks = grid.normalize(next).map(b => ({
    id: b.id, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h,
    ...(b.type === 'file' ? { fileId: idOf(b.fileId) } : { folderId: idOf(b.folderId) }),
  }));
  const bytes = tabBytes({ ...current, blocks });
  if (bytes > LIMITS.tabBytes) throw new BoardInputError('This tab is too large to save.', 413);
  const others = await WorkspaceTab.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(idOf(userId)), tabId: { $ne: tabId } } },
    { $group: { _id: null, total: { $sum: '$bytes' } } },
  ]);
  if ((others[0]?.total || 0) + bytes > LIMITS.totalBytes) throw new BoardInputError('Your Boards are full. Remove something to add more.', 413);

  const updated = await WorkspaceTab.findOneAndUpdate(
    { user: userId, tabId, rev: body.rev },
    { $set: { blocks, bytes }, $inc: { rev: 1 } },
    { new: true }
  ).lean();
  if (!updated) throw await conflict(userId, tabId);
  return { tab: publicTab(updated), blocks: await resolveBlocks(userId, updated.blocks) };
}

async function conflict(userId, tabId) {
  const latest = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!latest) return new BoardInputError('Tab not found.', 404);
  return new BoardInputError('This board was changed somewhere else.', 409, { tab: publicTab(latest), blocks: await resolveBlocks(userId, latest.blocks || []) });
}

module.exports = { LIMITS, COLORS, SIZES: grid.SIZES, BoardInputError, cleanName, cleanIcon, cleanColor, listTabs, createTab, updateTab, deleteTab, getTab, saveBlocks, resolveBlocks, DEFAULT_TAB_NAME };
