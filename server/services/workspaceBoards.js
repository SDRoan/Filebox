const crypto = require('crypto');
const mongoose = require('mongoose');
const WorkspaceTab = require('../models/WorkspaceTab');
const File = require('../models/File');
const Folder = require('../models/Folder');
const TeamFolder = require('../models/TeamFolder');
const FileContent = require('../models/FileContent');
const User = require('../models/User');
const layout = require('../utils/boardLayout');
const { effectiveClassification } = require('./fileClassifier');
const { technicalType } = require('./advancedSearch');
const { cleanDoc, RichTextError } = require('./richTextSchema');
const { CLEANERS: BLOCK_CLEANERS, BlockError } = require('./boardBlocks');

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
const BLOCK_TYPES = ['file', 'folder', 'note', 'text', 'checklist', 'label', 'deadline'];
const NOTE_COLORS = Object.freeze(['yellow', 'pink', 'blue', 'green', 'purple', 'orange']);
const REF_TYPES = ['file', 'folder'];
const NOTE_CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

/** A sticky note: plain text only. Title one line, up to 80 characters; body up to 4,000; one of six colours. */
function cleanNote(raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new BoardInputError('This note could not be saved.');
  const text = (value) => (typeof value === 'string' ? value : '');
  const title = text(raw?.title).replace(/\s+/g, ' ').replace(NOTE_CONTROL, '').trim();
  const body = text(raw?.body).replace(/\r\n?/g, '\n').replace(NOTE_CONTROL, '');
  if (Array.from(title).length > LIMITS.noteTitle) throw new BoardInputError(`Note titles can be up to ${LIMITS.noteTitle} characters.`);
  if (Array.from(body).length > LIMITS.noteBody) throw new BoardInputError(`A note can hold up to ${LIMITS.noteBody.toLocaleString('en-US')} characters.`);
  return { title, body, color: NOTE_COLORS.includes(raw?.color) ? raw.color : 'yellow' };
}

/**
 * The content of a block that is not a file or folder, cleaned for its type. Each type keeps its content
 * in a field named after it (note, text, checklist, label, deadline).
 */
function cleanContent(type, raw) {
  if (type === 'note') return cleanNote(raw);
  if (type === 'text') return cleanTextBlock(raw);
  try {
    return BLOCK_CLEANERS[type](raw);
  } catch (error) {
    if (error instanceof BlockError) throw new BoardInputError(error.message, error.status);
    throw error;
  }
}

/** A text area's document, cleaned against the rich-text allowlist (services/richTextSchema.js). */
function cleanTextBlock(raw) {
  if (raw === undefined) return { doc: { type: 'doc', content: [{ type: 'paragraph' }] } };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BoardInputError('This text could not be saved.');
  try {
    return { doc: cleanDoc(raw.doc).doc };
  } catch (error) {
    if (error instanceof RichTextError) throw new BoardInputError(error.message, error.status);
    throw error;
  }
}
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

const tabBytes = (tab) => Buffer.byteLength(JSON.stringify({ name: tab.name, icon: tab.icon, color: tab.color, blocks: tab.blocks || [], zones: tab.zones || [] }), 'utf8');

/**
 * A tab's layout on the free canvas (pixel positions and zones). Tabs saved before the canvas used a
 * 12-column grid; those are converted the same deterministic way the migration does, without writing.
 */
const LAYOUT_VERSION = 2;
const canvasOf = (tab) => (tab.layoutVersion === LAYOUT_VERSION
  ? { blocks: tab.blocks || [], zones: tab.zones || [] }
  : { blocks: layout.fromGrid(tab.blocks || []), zones: [] });

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

async function createTabRecord(userId, { name, icon = '', color = '', isDefault = false, blocks = [], zones = [] }, existing) {
  const order = existing.length ? Math.max(...existing.map(t => t.order)) + 1 : 0;
  const record = { user: userId, tabId: newTabId(), name, icon, color, order, isDefault, rev: 0, blocks, zones, layoutVersion: LAYOUT_VERSION };
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
 * Rename a tab, or change its emoji or color. `rev` must be the revision the browser last saw; if the tab
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
      .select('originalName mimeType size owner parentFolder isTrashed isStarred sharedWith updatedAt createdAt aiCaption dataClassification').lean();
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
        // What the board's file card shows (the same card as in My Files).
        createdAt: file.createdAt,
        ...(file.dataClassification ? { dataClassification: file.dataClassification } : {}),
        ...(String(file.mimeType || '').startsWith('image/') && file.aiCaption ? { aiCaption: { text: file.aiCaption.text || '', hashtags: file.aiCaption.hashtags || [], status: file.aiCaption.status || '', error: file.aiCaption.error || '' } } : {}),
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
    const found = await Folder.find({ _id: { $in: dIds } }).select('name owner parentFolder isTrashed isStarred createdAt dataClassification').lean();
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
        createdAt: folder.createdAt,
        ...(folder.dataClassification ? { dataClassification: folder.dataClassification } : {}),
        ...(owned ? { isStarred: Boolean(folder.isStarred) } : {}),
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
    const place = { id: b.id, type: b.type, x: b.x, y: b.y, w: b.w, h: b.h };
    if (!REF_TYPES.includes(b.type)) return { ...place, [b.type]: b[b.type] };
    const ref = b.type === 'file' ? files.get(idOf(b.fileId)) : folders.get(idOf(b.folderId));
    return { ...place, ref: ref || { available: false } };
  });
}

async function getTab(userId, tabId) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const tab = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!tab) throw new BoardInputError('Tab not found.', 404);
  const { blocks, zones } = canvasOf(tab);
  return { tab: publicTab(tab), blocks: await resolveBlocks(userId, blocks), zones };
}

/**
 * Save a tab's board (positions, sizes, zones, adds and removals). The browser's list is only a request:
 *  - an existing block keeps the type and reference stored on the server (ids the browser sends for it are ignored)
 *  - a new block must point at a file or folder the person can open right now
 *  - the same file or folder may not appear twice on one tab
 *  - positions are pixels on the free canvas (or null: not placed yet), clamped like My Files > Board;
 *    zones are checked exactly like My Files > Board's (utils/boardLayout.js); left out, the stored ones stay
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

  const canvas = canvasOf(current);
  const stored = new Map(canvas.blocks.map(b => [b.id, b]));
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
      if (!type) throw new BoardInputError(UNAVAILABLE_TO_ADD);
      if (!REF_TYPES.includes(type)) base = { id, type, [type]: cleanContent(type, raw[type]) };
      else {
        const refId = type === 'file' ? raw.fileId : raw.folderId;
        if (typeof refId !== 'string' || !mongoose.isValidObjectId(refId) || String(new mongoose.Types.ObjectId(refId)) !== refId) {
          throw new BoardInputError(UNAVAILABLE_TO_ADD);
        }
        base = { id, type, ...(type === 'file' ? { fileId: refId } : { folderId: refId }) };
        added[type].push(refId);
      }
    } else if (!REF_TYPES.includes(base.type) && raw[base.type] !== undefined) {
      // A block's content comes from the browser only when it was edited; otherwise the stored content stays.
      base = { ...base, [base.type]: cleanContent(base.type, raw[base.type]) };
    }
    if (REF_TYPES.includes(base.type)) {
      const key = `${base.type}:${idOf(base.type === 'file' ? base.fileId : base.folderId)}`;
      if (refs.has(key)) throw new BoardInputError(`That ${base.type} is already on this tab.`);
      refs.add(key);
    }
    const { x, y, w, h, ...content } = base;
    return { ...content, ...layout.cleanPlace(raw, base.type) };
  });
  const zones = body.zones === undefined ? canvas.zones : layout.cleanZones(body.zones);

  if (added.file.length || added.folder.length) {
    const { files, folders } = await resolveRefs(userId, added.file, added.folder, { withDetails: false });
    if (added.file.some(id => !files.has(id)) || added.folder.some(id => !folders.has(id))) throw new BoardInputError(UNAVAILABLE_TO_ADD);
  }

  const blocks = storedBlocks(next);
  const bytes = await checkSize(userId, current, blocks, zones);

  const updated = await WorkspaceTab.findOneAndUpdate(
    { user: userId, tabId, rev: body.rev },
    { $set: { blocks, zones, bytes, layoutVersion: LAYOUT_VERSION }, $inc: { rev: 1 } },
    { new: true }
  ).lean();
  if (!updated) throw await conflict(userId, tabId);
  return { tab: publicTab(updated), blocks: await resolveBlocks(userId, updated.blocks), zones: updated.zones };
}

/** Blocks as they are stored: pixel place (and size for notes and text), with only the fields each type keeps. */
const storedBlocks = (list) => list.map(b => ({
  id: b.id, type: b.type, ...layout.cleanPlace(b, b.type),
  ...(b.type === 'file' ? { fileId: idOf(b.fileId) } : b.type === 'folder' ? { folderId: idOf(b.folderId) } : { [b.type]: b[b.type] }),
}));

/** The tab's new size in bytes, if it fits within the tab and per-person limits. */
async function checkSize(userId, current, blocks, zones = current.zones || []) {
  const bytes = tabBytes({ ...current, blocks, zones });
  if (bytes > LIMITS.tabBytes) throw new BoardInputError('This tab is too large to save.', 413);
  const others = await WorkspaceTab.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(idOf(userId)), tabId: { $ne: current.tabId } } },
    { $group: { _id: null, total: { $sum: '$bytes' } } },
  ]);
  if ((others[0]?.total || 0) + bytes > LIMITS.totalBytes) throw new BoardInputError('Your Boards are full. Remove something to add more.', 413);
  return bytes;
}

// ---- Tab management (Phase 4). Order and the default are not content: they never change a tab's
// revision or its "updated" time, so they never conflict with block saves.

/** "Work copy", "Work copy 2", … kept within the name limit and different from every existing name. */
function copyName(name, taken) {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = `${[...name].slice(0, LIMITS.tabName - suffix.length).join('').trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Write only the orders that change. */
async function writeOrder(userId, tabIds, tabs) {
  const orderOf = new Map(tabs.map(t => [t.tabId, t.order]));
  const ops = tabIds.flatMap((tabId, order) => (orderOf.get(tabId) === order ? [] : [{ updateOne: { filter: { user: userId, tabId }, update: { $set: { order } }, timestamps: false } }]));
  if (ops.length) await WorkspaceTab.bulkWrite(ops, { timestamps: false });
}

/**
 * Copy a tab: its name (as "… copy"), emoji, colour, layout, sticky notes and text areas, and the files
 * and folders it points at that the person can open now (never the files or folders themselves).
 * Unavailable items are left out and counted. The copy sits right after the original.
 */
async function duplicateTab(userId, tabId) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const source = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!source) throw new BoardInputError('Tab not found.', 404);
  const existing = await WorkspaceTab.find({ user: userId }).select('tabId name order bytes').sort({ order: 1, createdAt: 1 }).lean();
  if (existing.length >= LIMITS.tabs) throw new BoardInputError(`You can have up to ${LIMITS.tabs} tabs.`, 409);
  const { blocks: srcBlocks, zones } = canvasOf(source);
  const { files, folders } = await resolveRefs(userId,
    srcBlocks.filter(b => b.type === 'file').map(b => idOf(b.fileId)),
    srcBlocks.filter(b => b.type === 'folder').map(b => idOf(b.folderId)), { withDetails: false });
  const ids = new Set();
  const freshId = () => { let id; do { id = newTabId(); } while (ids.has(id)); ids.add(id); return id; };
  const kept = srcBlocks.filter(b => (b.type === 'file' ? files.has(idOf(b.fileId)) : b.type === 'folder' ? folders.has(idOf(b.folderId)) : true));
  const blocks = storedBlocks(kept.map(b => ({ ...b, id: freshId() })));
  const record = await createTabRecord(userId, { name: copyName(source.name, new Set(existing.map(t => t.name))), icon: source.icon || '', color: source.color || '', blocks, zones }, existing);
  const order = existing.map(t => t.tabId);
  order.splice(order.indexOf(tabId) + 1, 0, record.tabId);
  await writeOrder(userId, order, [...existing, record]);
  return { tab: publicTab({ ...record, order: order.indexOf(record.tabId) }), tabs: await listTabs(userId), skipped: srcBlocks.length - kept.length };
}

/** Put the tabs in this order. The list must name every one of the person's tabs exactly once. */
async function reorderTabs(userId, body = {}) {
  const tabIds = body.tabIds;
  const tabs = await WorkspaceTab.find({ user: userId }).select('tabId order').lean();
  const known = new Set(tabs.map(t => t.tabId));
  const valid = Array.isArray(tabIds) && tabIds.length === known.size && new Set(tabIds).size === tabIds.length && tabIds.every(id => typeof id === 'string' && known.has(id));
  if (!valid) throw new BoardInputError('Your tabs were changed somewhere else. Showing the latest order.', 409, { tabs: await listTabs(userId) });
  await writeOrder(userId, tabIds, tabs);
  return listTabs(userId);
}

/** Make this the tab that opens when Boards is opened. Exactly one tab is the default afterwards. */
async function setDefaultTab(userId, tabId) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  if (!(await WorkspaceTab.exists({ user: userId, tabId }))) throw new BoardInputError('Tab not found.', 404);
  // One update for all of this person's tabs (unchanged ones are not rewritten); listTabs settles any race.
  await WorkspaceTab.updateMany({ user: userId }, [{ $set: { isDefault: { $eq: ['$tabId', tabId] } } }], { timestamps: false });
  return listTabs(userId);
}

/** Which of this person's own tabs already hold this file or folder (ids only). */
async function placements(userId, query = {}) {
  const type = query.fileId !== undefined ? 'file' : query.folderId !== undefined ? 'folder' : null;
  const refId = type === 'file' ? query.fileId : query.folderId;
  if (!type || typeof refId !== 'string' || !mongoose.isValidObjectId(refId)) throw new BoardInputError('Choose a file or folder.');
  const field = type === 'file' ? 'fileId' : 'folderId';
  const tabs = await WorkspaceTab.find({ user: userId, blocks: { $elemMatch: { type, [field]: refId } } }).select('tabId').lean();
  return { tabIds: tabs.map(t => t.tabId) };
}

/**
 * "Add to board" from a file or folder menu: the server checks the person can open it now and adds it
 * without a place; the board puts it below everything (as My Files > Board does) and keeps that spot.
 * Retries a few times if the tab is being saved at the same moment.
 */
async function addRef(userId, tabId, body = {}) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const type = REF_TYPES.includes(body.type) ? body.type : null;
  const refId = body.id;
  if (!type || typeof refId !== 'string' || !mongoose.isValidObjectId(refId) || String(new mongoose.Types.ObjectId(refId)) !== refId) throw new BoardInputError(UNAVAILABLE_TO_ADD);
  const { files, folders } = await resolveRefs(userId, type === 'file' ? [refId] : [], type === 'folder' ? [refId] : [], { withDetails: false });
  if (!(type === 'file' ? files : folders).has(refId)) throw new BoardInputError(UNAVAILABLE_TO_ADD);
  const field = type === 'file' ? 'fileId' : 'folderId';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // Another save got there first: wait a moment (a little longer each time, at random) and try again.
    if (attempt) await new Promise(resolve => setTimeout(resolve, 10 * attempt + Math.random() * 30));
    const current = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
    if (!current) throw new BoardInputError('Tab not found.', 404);
    const canvas = canvasOf(current);
    const list = canvas.blocks;
    if (list.some(b => b.type === type && idOf(b[field]) === refId)) return { tab: publicTab(current), added: false };
    if (list.length >= LIMITS.blocksPerTab) throw new BoardInputError(`This board is full (${LIMITS.blocksPerTab} items).`, 409);
    let id;
    do { id = newTabId(); } while (list.some(b => b.id === id));
    const blocks = storedBlocks([...list, { id, type, x: null, y: null, [field]: refId }]);
    const bytes = await checkSize(userId, current, blocks, canvas.zones);
    const updated = await WorkspaceTab.findOneAndUpdate(
      { user: userId, tabId, rev: current.rev },
      { $set: { blocks, zones: canvas.zones, bytes, layoutVersion: LAYOUT_VERSION }, $inc: { rev: 1 } },
      { new: true }
    ).lean();
    if (updated) return { tab: publicTab(updated), added: true, blockId: id };
  }
  throw new BoardInputError('This board is being changed right now. Try again.', 409);
}

async function conflict(userId, tabId) {
  const latest = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!latest) return new BoardInputError('Tab not found.', 404);
  const { blocks, zones } = canvasOf(latest);
  return new BoardInputError('This board was changed somewhere else.', 409, { tab: publicTab(latest), blocks: await resolveBlocks(userId, blocks), zones });
}

module.exports = {
  LIMITS, COLORS, NOTE_COLORS, SIZES: layout.SIZES, LAYOUT_VERSION, canvasOf, BoardInputError, cleanName, cleanIcon, cleanColor, listTabs, createTab, updateTab, deleteTab,
  getTab, saveBlocks, resolveBlocks, duplicateTab, reorderTabs, setDefaultTab, placements, addRef, DEFAULT_TAB_NAME,
};
