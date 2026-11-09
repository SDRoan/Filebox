const mongoose = require('mongoose');
const WorkspaceTab = require('../models/WorkspaceTab');
const FileRelationship = require('../models/FileRelationship');
const { BoardInputError, TAB_ID, canvasOf, listFileIds, resolveRefs } = require('./workspaceBoards');

/**
 * The file relationships a Board's Connections view draws. Read-only: nothing here writes to a tab, a file or a
 * relationship. A file relationship is a fact between a person's files; a Board connector is a line on one tab. They
 * are stored apart and stay apart: this returns relationships only, and the browser adds the tab's own connectors.
 *
 * "This Board" is every relationship of the person's with at least one end on the tab, so a file that is not on the
 * tab appears one hop out and never further. "All my files" is every relationship they have.
 *
 * An end they cannot open right now (trashed, deleted, no longer shared) makes the relationship unavailable: it comes
 * back with only its own id, for removing it, and the id of an end they can still open. Its type, label and
 * description can name the other file, so they are left out.
 */
const MAX_EDGES = 500;
const SCOPES = ['board', 'all'];

const idOf = (value) => String(value);

function boardFileIds(blocks) {
  const ids = [...blocks.filter(b => b.type === 'file').map(b => b.fileId), ...blocks.flatMap(listFileIds)].map(idOf);
  return [...new Set(ids)].filter(id => mongoose.isValidObjectId(id));
}

async function tabConnections(userId, tabId, query = {}) {
  if (!TAB_ID.test(tabId || '')) throw new BoardInputError('Tab not found.', 404);
  const scope = query.scope === undefined ? 'board' : query.scope;
  if (!SCOPES.includes(scope)) throw new BoardInputError('Choose This Board or All my files.', 400);
  const tab = await WorkspaceTab.findOne({ user: userId, tabId }).lean();
  if (!tab) throw new BoardInputError('Tab not found.', 404);

  const answer = (rows = [], files = new Map(), truncated = false) => {
    const relationships = [];
    const unavailable = [];
    const shown = new Map();
    rows.forEach((row) => {
      const source = files.get(idOf(row.sourceFile));
      const target = files.get(idOf(row.targetFile));
      [source, target].forEach(file => { if (file) shown.set(file.fileId, file); });
      if (source && target) {
        relationships.push({ id: idOf(row._id), source: source.fileId, target: target.fileId, type: row.relationshipType, label: row.customLabel || '', description: row.description || '', createdAt: row.createdAt });
      } else {
        unavailable.push({ id: idOf(row._id), fileId: (source || target)?.fileId || null });
      }
    });
    return {
      scope, tabId, relationships, unavailable,
      files: [...shown.values()].map(({ fileId, name, mimeType, size, source }) => ({ fileId, name, mimeType, size, source })),
      truncated, limit: MAX_EDGES,
    };
  };

  const filter = { owner: userId };
  if (scope === 'board') {
    const ids = boardFileIds(canvasOf(tab).blocks);
    if (!ids.length) return answer();
    filter.$or = [{ sourceFile: { $in: ids } }, { targetFile: { $in: ids } }];
  }
  const found = await FileRelationship.find(filter)
    .sort({ createdAt: -1, _id: -1 }).limit(MAX_EDGES + 1)
    .select('sourceFile targetFile relationshipType customLabel description createdAt').lean();
  const rows = found.slice(0, MAX_EDGES);
  const { files } = await resolveRefs(userId, rows.flatMap(r => [idOf(r.sourceFile), idOf(r.targetFile)]), [], { withDetails: false });
  return answer(rows, files, found.length > MAX_EDGES);
}

module.exports = { tabConnections, MAX_EDGES };
