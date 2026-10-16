const File = require('../models/File');
const Folder = require('../models/Folder');
const Share = require('../models/Share');
const FileVersion = require('../models/FileVersion');
const config = require('../config/aiConfig');
const ollamaClient = require('./ollamaClient');
const { findDuplicates } = require('./storageSummary');

/**
 * Suggestions for duplicate files the user owns. Detection is by identical contents (Phase 2).
 * Choosing which copy to keep is rule-based and explained; when copies are equally good we say so.
 * Nothing here deletes anything.
 */

const COPY_NAME = /(\(\d+\)|\bcopy\b|copy of|- copy|_copy|\bduplicate\b)/i;

async function folderPathName(folderId, cache) {
  if (!folderId) return 'My Files';
  const key = folderId.toString();
  if (cache.has(key)) return cache.get(key);
  const names = [];
  let current = folderId;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const folder = await Folder.findById(current).select('name parentFolder').lean();
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parentFolder;
  }
  const result = names.length ? `My Files / ${names.join(' / ')}` : 'My Files';
  cache.set(key, result);
  return result;
}

function chooseKeeper(copies) {
  // Only a strictly oldest copy counts as "the original"; equal dates prove nothing.
  const times = copies.map(c => new Date(c.createdAt).getTime());
  const minTime = Math.min(...times);
  const oldest = times.filter(t => t === minTime).length === 1 ? copies[times.indexOf(minTime)] : null;
  const scored = copies.map(copy => {
    const reasons = [];
    let score = 0;
    if (copy.shareCount > 0) { score += 3; reasons.push(`shared with ${copy.shareCount} ${copy.shareCount === 1 ? 'person or link' : 'people or links'}; removing it would break sharing`); }
    if (copy.isStarred) { score += 2; reasons.push('starred'); }
    if (copy.versionCount > 0) { score += 1; reasons.push(`has ${copy.versionCount} saved version${copy.versionCount === 1 ? '' : 's'}`); }
    if (copy.parentFolder) { score += 1; reasons.push(`organized in ${copy.location}`); }
    if (oldest && copy === oldest) { score += 1; reasons.push('the oldest copy, likely the original'); }
    if (COPY_NAME.test(copy.originalName)) { score -= 2; reasons.push('the name looks like a copy'); }
    return { copy, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  const confident = !second || best.score > second.score;
  return { scored, keep: confident ? best.copy : null, confident };
}

async function buildDuplicateSuggestions(userId, { explain = false } = {}) {
  const files = await File.find({ owner: userId, isTrashed: { $ne: true } })
    .select('originalName size mimeType path parentFolder updatedAt createdAt isStarred sharedWith').lean();
  const { groups, complete } = await findDuplicates(files);
  const byId = new Map(files.map(f => [f._id.toString(), f]));
  const locationCache = new Map();

  const suggestions = [];
  for (const group of groups) {
    const ids = group.files.map(f => f._id);
    const [linkCounts, versionCounts] = await Promise.all([
      Share.aggregate([{ $match: { file: { $in: ids } } }, { $group: { _id: '$file', n: { $sum: 1 } } }]),
      FileVersion.aggregate([{ $match: { file: { $in: ids } } }, { $group: { _id: '$file', n: { $sum: 1 } } }]),
    ]);
    const links = new Map(linkCounts.map(l => [l._id.toString(), l.n]));
    const versions = new Map(versionCounts.map(v => [v._id.toString(), v.n]));

    const copies = [];
    for (const summary of group.files) {
      const file = byId.get(summary._id.toString());
      copies.push({
        _id: file._id,
        originalName: file.originalName,
        size: file.size,
        parentFolder: file.parentFolder || null,
        location: await folderPathName(file.parentFolder, locationCache),
        updatedAt: file.updatedAt,
        createdAt: file.createdAt,
        isStarred: Boolean(file.isStarred),
        shareCount: (file.sharedWith || []).length + (links.get(file._id.toString()) || 0),
        versionCount: versions.get(file._id.toString()) || 0,
      });
    }

    const { scored, keep, confident } = chooseKeeper(copies);
    suggestions.push({
      size: group.size,
      reclaimableBytes: group.reclaimableBytes,
      why: `These ${copies.length} files have exactly the same contents (identical SHA-256 checksum).`,
      confident,
      keepId: keep ? keep._id : null,
      note: confident
        ? `Keep "${keep.originalName}" (${keep.location}).`
        : 'These copies look equally important, so File Box will not guess which to keep. Choose yourself.',
      copies: scored.map(({ copy, reasons }) => ({ ...copy, reasons, suggested: keep ? (copy._id.equals(keep._id) ? 'keep' : 'remove') : null })),
    });
  }

  let explanation = null;
  if (explain && suggestions.length) {
    const health = await ollamaClient.health();
    if (health.reachable && health.assistantModelAvailable) {
      const brief = suggestions.slice(0, 10).map((s, i) => `Group ${i + 1}: ${s.copies.map(c => `"${c.originalName}" in ${c.location}${c.suggested ? ` (${c.suggested})` : ''}`).join(', ')}. ${s.note}`).join('\n');
      explanation = (await ollamaClient.chatText({
        model: config.ollama.assistantModel,
        system: 'Explain duplicate-file cleanup suggestions to a user in 2-4 plain sentences. Do not change the suggestions, do not suggest deleting anything not listed, and remind them nothing is removed until they confirm.',
        content: brief,
        options: { temperature: 0.2 },
      })).trim();
    }
  }

  return {
    groups: suggestions,
    complete,
    reclaimableBytes: suggestions.reduce((sum, s) => sum + s.reclaimableBytes, 0),
    explanation,
  };
}

module.exports = { buildDuplicateSuggestions, chooseKeeper };
