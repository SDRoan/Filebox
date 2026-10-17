const mongoose = require('mongoose');
const File = require('../models/File');
const Folder = require('../models/Folder');
const TeamFolder = require('../models/TeamFolder');
const User = require('../models/User');
const { readableFileFilter, describeAccess, authorizeFile, authorizeFolder } = require('./permissions');

/**
 * Turns a name the user typed ("report", "the Taxes 2026 folder") into exactly one file or folder,
 * or into a list of choices. It never picks between several matches: one permitted match proceeds,
 * none says so, several are returned for the user to choose from.
 *
 * Candidates come only from what the user may act on (the Phase 2 permission module):
 *   level 'owner'  - the user's own files (rename, move, share, trash, star, restore)
 *   level 'viewer' - everything the user may read: own files, active direct shares, Team Spaces
 */

const MAX_CANDIDATES = 50;
const MAX_CHOICES = 8;
const MAX_FOLDER_DEPTH = 32;

const LEADING_WORDS = /^(?:the|my|our|a|an|this|that|these|those|your)\s+/i;
const TRAILING_WORDS = /\s+(?:file|document|doc|folder|directory)$/i;
const IGNORED_WORDS = new Set(['the', 'my', 'our', 'a', 'an', 'this', 'that', 'file', 'files', 'document', 'doc', 'folder', 'directory', 'please']);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (value = '') => value.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (name = '') => name.replace(/\.[a-z0-9]{1,6}$/i, '');

/** "the Taxes 2026 folder" -> "Taxes 2026"; "\"report.pdf\"" -> "report.pdf" */
function cleanPhrase(phrase = '') {
  let value = String(phrase).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.,!?;:]+$/g, '').trim();
  for (let i = 0; i < 3 && LEADING_WORDS.test(value); i += 1) value = value.replace(LEADING_WORDS, '');
  value = value.replace(TRAILING_WORDS, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  return value;
}

const phraseWords = (phrase) => norm(phrase).split(/[^a-z0-9]+/).filter(word => word && !IGNORED_WORDS.has(word));

/**
 * Pick the matches in tiers: exact name, then exact name without extension, then every word present.
 * The first non-empty tier wins, so typing "report.pdf" is exact even if "report.docx" exists.
 */
function tierMatches(items, phrase, nameOf) {
  const wanted = norm(phrase);
  const exact = items.filter(item => norm(nameOf(item)) === wanted);
  if (exact.length) return exact;
  const byStem = items.filter(item => norm(stem(nameOf(item))) === wanted);
  if (byStem.length) return byStem;
  return items;
}

/** Where an item lives, for showing choices: "My Files / Reports", "Team Space: Design / Specs". */
async function locationOf(parentId, cache = new Map()) {
  if (!parentId) return { label: 'My Files', teamName: null };
  const key = parentId.toString();
  if (cache.has(key)) return cache.get(key);

  const names = [];
  let teamName = null;
  let current = parentId;
  for (let depth = 0; current && depth < MAX_FOLDER_DEPTH; depth += 1) {
    const folder = await Folder.findById(current).select('name parentFolder').lean();
    if (folder) {
      names.unshift(folder.name);
      current = folder.parentFolder;
      continue;
    }
    const team = await TeamFolder.findById(current).select('name').lean();
    if (team) teamName = team.name;
    break;
  }
  const base = teamName ? `Team Space: ${teamName}` : 'My Files';
  const result = { label: names.length ? `${base} / ${names.join(' / ')}` : base, teamName };
  cache.set(key, result);
  return result;
}

/** Stable order for showing choices; never the database's order. */
const compareChoices = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  || a.location.localeCompare(b.location)
  || new Date(b.updatedAt) - new Date(a.updatedAt)
  || a.id.localeCompare(b.id);

async function describeFile(file, userId, cache) {
  const access = await describeAccess(file, userId);
  if (!access) return null; // never show something the user cannot access
  let location;
  let sourceLabel;
  if (access.source === 'shared') {
    // Someone else's folder names are theirs; say who shared it instead.
    const owner = file.owner?.name ? file.owner : await User.findById(file.owner).select('name').lean();
    location = `Shared by ${owner?.name || 'someone'}`;
    sourceLabel = 'Shared with you';
  } else {
    const where = await locationOf(file.parentFolder, cache);
    location = file.isTrashed ? 'Trash' : where.label;
    sourceLabel = access.source === 'team' ? `Team Space: ${access.teamName || where.teamName || ''}`.trim() : 'Yours';
  }
  return {
    id: file._id.toString(),
    kind: 'file',
    name: file.originalName,
    location,
    source: access.source,
    sourceLabel,
    role: access.role,
    updatedAt: file.updatedAt,
  };
}

/**
 * Resolve a file phrase.
 * Returns { status: 'one', file, choice } | { status: 'none', otherAccess? } | { status: 'many', choices, more }.
 */
async function resolveFile(userId, phrase, { level = 'owner', trashed = false } = {}) {
  const cleaned = cleanPhrase(phrase);
  const words = phraseWords(cleaned);
  if (!words.length) return { status: 'none', phrase: cleaned };

  let scope;
  if (trashed) scope = { owner: userId, isTrashed: true };
  else if (level === 'owner') scope = { owner: userId, isTrashed: { $ne: true } };
  else scope = await readableFileFilter(userId);

  const nameFilter = { $regex: `^${words.map(word => `(?=.*${escapeRegex(word)})`).join('')}`, $options: 'i' };
  const found = await File.find({ $and: [scope, { originalName: nameFilter }] })
    .sort({ originalName: 1, _id: 1 })
    .limit(MAX_CANDIDATES);
  const matches = tierMatches(found, cleaned, file => file.originalName);

  const cache = new Map();
  const choices = [];
  for (const file of matches) {
    const choice = await describeFile(file, userId, cache);
    if (choice) choices.push({ choice, file });
  }
  choices.sort((a, b) => compareChoices(a.choice, b.choice));

  if (choices.length === 1) return { status: 'one', file: choices[0].file, choice: choices[0].choice, phrase: cleaned };
  if (choices.length > 1) {
    return { status: 'many', phrase: cleaned, choices: choices.slice(0, MAX_CHOICES).map(c => c.choice), more: Math.max(0, choices.length - MAX_CHOICES) };
  }

  // Nothing the user owns: say so, and mention a readable match they may not change.
  if (level === 'owner' && !trashed) {
    const readable = await resolveFile(userId, cleaned, { level: 'viewer' });
    if (readable.status !== 'none') {
      const sample = readable.status === 'one' ? readable.choice : readable.choices[0];
      return { status: 'none', phrase: cleaned, otherAccess: sample };
    }
  }
  return { status: 'none', phrase: cleaned };
}

/** Resolve a destination folder among the user's own folders. Same three outcomes as resolveFile. */
async function resolveFolder(userId, phrase) {
  const cleaned = cleanPhrase(phrase);
  const words = phraseWords(cleaned);
  if (!words.length) return { status: 'none', phrase: cleaned };

  const nameFilter = { $regex: `^${words.map(word => `(?=.*${escapeRegex(word)})`).join('')}`, $options: 'i' };
  const found = await Folder.find({ owner: userId, isTrashed: { $ne: true }, name: nameFilter })
    .sort({ name: 1, _id: 1 })
    .limit(MAX_CANDIDATES)
    .lean();
  const wanted = norm(cleaned);
  const exact = found.filter(folder => norm(folder.name) === wanted);
  const matches = exact.length ? exact : found;

  const cache = new Map();
  const choices = [];
  for (const folder of matches) {
    const where = await locationOf(folder.parentFolder, cache);
    choices.push({
      folder,
      choice: { id: folder._id.toString(), kind: 'folder', name: folder.name, location: where.label, source: 'owned', sourceLabel: 'Yours', updatedAt: folder.updatedAt },
    });
  }
  choices.sort((a, b) => compareChoices(a.choice, b.choice));

  if (choices.length === 1) return { status: 'one', folder: choices[0].folder, choice: choices[0].choice, phrase: cleaned };
  if (choices.length > 1) {
    return { status: 'many', phrase: cleaned, choices: choices.slice(0, MAX_CHOICES).map(c => c.choice), more: Math.max(0, choices.length - MAX_CHOICES) };
  }
  return { status: 'none', phrase: cleaned };
}

/**
 * A file the user picked from a list (or the selected file). Re-checked with the permission module:
 * the id comes from the browser and is never trusted on its own.
 */
async function fileById(userId, fileId, { level = 'owner', trashed = false } = {}) {
  if (!mongoose.isValidObjectId(fileId)) return null;
  const access = await authorizeFile(fileId, userId, level);
  if (access.status) return null;
  if (Boolean(access.file.isTrashed) !== Boolean(trashed)) return null;
  return access.file;
}

async function folderById(userId, folderId) {
  if (!mongoose.isValidObjectId(folderId)) return null;
  const access = await authorizeFolder(folderId, userId, 'owner');
  if (access.status || access.folder.isTrashed) return null;
  return access.folder;
}

// A restored item goes back to its folder only if that folder still exists, is not in Trash,
// and is not inside a trashed folder; otherwise it returns to My Files.
async function restorableParent(parentId, userId) {
  let current = parentId;
  for (let depth = 0; current && depth < MAX_FOLDER_DEPTH; depth += 1) {
    const folder = await Folder.findOne({ _id: current, owner: userId }).select('isTrashed parentFolder').lean();
    if (!folder) return Boolean(await TeamFolder.exists({ _id: current })); // Team Space files keep their space
    if (folder.isTrashed) return false;
    current = folder.parentFolder;
  }
  return Boolean(parentId);
}

module.exports = {
  cleanPhrase,
  resolveFile,
  resolveFolder,
  fileById,
  folderById,
  restorableParent,
};
