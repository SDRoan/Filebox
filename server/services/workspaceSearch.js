const File = require('../models/File');
const Folder = require('../models/Folder');
const FileContent = require('../models/FileContent');
const aiSearch = require('./aiSearch');
const config = require('../config/aiConfig');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Search a user's own files by content and name, plus folders by name.
 * Fully local and deterministic, so it works when Ollama is not running.
 */
async function searchWorkspace(userId, query, { limit = config.search.maxResults } = {}) {
  const files = await File.find({
    owner: userId,
    isTrashed: { $ne: true }
  }).populate('parentFolder');

  const fileContents = await FileContent.find({
    file: { $in: files.map(f => f._id) }
  }).populate({
    path: 'file',
    populate: { path: 'parentFolder' }
  });
  const indexed = fileContents.filter(fc => fc.file);

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

  return {
    files: uniqueFiles.slice(0, limit),
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
