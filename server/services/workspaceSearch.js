const File = require('../models/File');
const Folder = require('../models/Folder');
const FileContent = require('../models/FileContent');
const aiSearch = require('./aiSearch');
const config = require('../config/aiConfig');
const { readableFileFilter, filterReadable } = require('./permissions');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Search files by content and name, plus the user's folders by name.
 * Fully local and deterministic, so it works when Ollama is not running.
 *
 * scope 'owned'      - only the user's own files (header search)
 * scope 'accessible' - everything the shared permission rules allow: owned, active direct shares, Team Spaces
 * includeTrash       - also the user's own trashed files (Trash is private to its owner)
 *
 * Every returned file carries `access` ({ role, source: 'owned' | 'shared' | 'team', teamName }).
 */
async function searchWorkspace(userId, query, { limit = config.search.maxResults, scope = 'owned', includeTrash = false } = {}) {
  const base = scope === 'accessible' ? await readableFileFilter(userId) : { owner: userId, isTrashed: { $ne: true } };
  const filter = includeTrash ? { $or: [base, { owner: userId, isTrashed: true }] } : base;
  // parentFolder stays an id: Team Space files have a TeamFolder parent, and the permission
  // check needs that id to find the Space.
  const files = await File.find(filter).populate('owner', 'name email');
  const filesById = new Map(files.map(f => [f._id.toString(), f]));

  const fileContents = await FileContent.find({ file: { $in: files.map(f => f._id) } });
  // Attach the already-loaded file document to each content record.
  const indexed = fileContents
    .filter(fc => filesById.has(fc.file.toString()))
    .map(fc => ({ file: filesById.get(fc.file.toString()), extractedText: fc.extractedText, embedding: fc.embedding }));

  const semanticResults = await aiSearch.semanticSearch(query, indexed);
  const keywordResults = aiSearch.keywordSearch(query, indexed);

  const indexedIds = new Set(indexed.map(fc => fc.file._id.toString()));
  const filenameOnlyResults = aiSearch.keywordSearch(query,
    files
      .filter(f => !indexedIds.has(f._id.toString()))
      .map(f => ({ file: f, extractedText: '', embedding: [] }))
  );

  // Prioritize semantic > content keyword > filename only
  const ranked = [
    ...semanticResults.map(r => ({ file: r.fileContent.file, score: r.score * 1.5 })),
    ...keywordResults.map(r => ({ file: r.fileContent.file, score: r.score })),
    ...filenameOnlyResults.map(r => ({ file: r.fileContent.file, score: r.score * 0.3 }))
  ].sort((a, b) => b.score - a.score);

  const seen = new Set();
  const uniqueFiles = [];
  ranked.forEach(({ file }) => {
    const id = file._id.toString();
    if (!seen.has(id)) {
      seen.add(id);
      uniqueFiles.push(file);
    }
  });

  const folders = await Folder.find({
    owner: userId,
    isTrashed: { $ne: true },
    name: { $regex: escapeRegex(query), $options: 'i' }
  }).limit(config.search.folderSearchLimit);

  // Confirm each file with the same role check the API routes use, label it, and drop duplicates.
  const readable = await filterReadable(uniqueFiles, userId);
  const parentIds = [...new Set(readable.map(({ file }) => file.parentFolder?.toString()).filter(Boolean))];
  const parentNames = new Map((await Folder.find({ _id: { $in: parentIds } }).select('name').lean()).map(f => [f._id.toString(), f.name]));
  const annotated = readable.map(({ file, access }) => {
    const item = file.toObject();
    item.folderName = item.parentFolder ? parentNames.get(item.parentFolder.toString()) || null : null;
    if (access.role !== 'owner') {
      // Never hand out server paths, other recipients or access logs for files someone else owns.
      delete item.path;
      delete item.sharedWith;
      delete item.accessLog;
    }
    return { ...item, access };
  });

  return {
    files: annotated.slice(0, limit),
    folders,
    stats: {
      semanticResults: semanticResults.length,
      contentKeywordResults: keywordResults.length,
      filenameOnlyResults: filenameOnlyResults.length,
      filesWithContent: indexed.length,
      totalFiles: files.length
    }
  };
}

module.exports = { searchWorkspace };
