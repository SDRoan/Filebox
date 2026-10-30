const mongoose = require('mongoose');
const Folder = require('../models/Folder');
const TeamFolder = require('../models/TeamFolder');
const { advancedSearch } = require('./advancedSearch');
const { getFolderRole, getTeamRole } = require('./permissions');

/**
 * Boards saved searches: a block keeps only structured filters (services/boardBlocks.js cleanSavedSearch);
 * its results are worked out by Advanced Search itself each time they are shown, with this person's access
 * as it is right now. Words are searched exactly as saved (parse: 'off') and never by meaning
 * (semantic: 'off'), so running a saved search never calls the AI model. Nothing a search finds is stored.
 *
 * A saved search limited to a folder or one Team Space that this person can no longer open is
 * { state: 'unavailable' }: no count, no results, no name.
 */

const CONCURRENCY = 2;
const MAX_RUN = 10;

/** The options Advanced Search runs a saved search with (`tz` is the browser's, so "today" is the person's day). */
const engineOptions = (s, tz) => ({
  text: s.text, category: s.category, documentType: s.documentType, topic: s.topic, format: s.format,
  date: s.date, from: s.from || undefined, to: s.to || undefined, dateField: s.dateField,
  location: s.location, folderId: s.folderId || undefined, teamId: s.teamId || undefined,
  sort: s.sort, limit: s.show, offset: 0, tz, parse: 'off', semantic: 'off',
});

/**
 * Can this person open the saved search's folder or Team Space right now (the same checks Advanced Search
 * uses)? Returns its current name, or null. Other locations have no single place to check: { name: '' }.
 */
async function scopeOf(userId, s) {
  const id = s.location === 'folder' ? s.folderId : s.location === 'team' ? s.teamId : null;
  if (!id) return { name: '' };
  if (!mongoose.isValidObjectId(id)) return null;
  const team = await TeamFolder.findById(id).select('name owner members').lean();
  if (team) return getTeamRole(team, userId) ? { name: team.name } : null;
  if (s.location === 'team') return null;
  const folder = await Folder.findById(id).select('name owner parentFolder isTrashed').lean();
  return folder && (await getFolderRole(folder, userId)) ? { name: folder.name } : null;
}

/** What a result row may show and what the normal preview needs; never a snippet, score or classification. */
const row = (r) => ({
  _id: r._id, originalName: r.originalName, mimeType: r.mimeType, size: r.size, technicalType: r.technicalType,
  createdAt: r.createdAt, updatedAt: r.updatedAt, parentFolder: r.parentFolder, folderName: r.folderName,
  isStarred: r.isStarred, ownerName: r.ownerName, access: r.access,
});

async function runOne(userId, block, tz) {
  const s = block.search;
  const result = await advancedSearch(userId, engineOptions(s, tz));
  if (result.folderNotFound) return { id: block.id, state: 'unavailable' };
  // The name is read only once the search confirmed the place can be opened.
  const scope = s.location === 'folder' || (s.location === 'team' && s.teamId) ? await scopeOf(userId, s) : { name: '' };
  if (!scope) return { id: block.id, state: 'unavailable' };
  return { id: block.id, state: 'ok', total: result.total, results: result.results.map(row), ...(scope.name ? { scopeName: scope.name } : {}), tookMs: result.tookMs };
}

/** Run the given saved-search blocks, at most two at a time, in the order asked. */
async function runSearches(userId, blocks, tz) {
  const list = blocks.slice(0, MAX_RUN);
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      try { out[i] = await runOne(userId, list[i], tz); } catch { out[i] = { id: list[i].id, state: 'error' }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return out;
}

module.exports = { runSearches, scopeOf, engineOptions, CONCURRENCY, MAX_RUN };
