const crypto = require('crypto');
const fs = require('fs-extra');
const File = require('../models/File');
const Folder = require('../models/Folder');
const User = require('../models/User');
const { trashSize } = require('./trash');

const CATEGORY_ORDER = ['Documents', 'Images', 'Videos', 'Audio', 'Archives', 'Other'];
const DOCUMENT_EXT = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'key', 'pages', 'numbers', 'json', 'xml', 'html', 'htm'];
const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'];

// Limits so duplicate detection stays quick on large drives.
const MAX_HASH_FILES = 300;
const MAX_HASH_BYTES = 1024 * 1024 * 1024;

const extensionOf = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function categoryOf(mimeType = '', name = '') {
  const ext = extensionOf(name);
  if (mimeType.startsWith('image/')) return 'Images';
  if (mimeType.startsWith('video/')) return 'Videos';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (ARCHIVE_EXT.includes(ext) || /zip|compressed|x-tar|x-7z|x-rar/.test(mimeType)) return 'Archives';
  if (mimeType.startsWith('text/') || /pdf|word|document|sheet|excel|presentation|powerpoint|json|xml/.test(mimeType) || DOCUMENT_EXT.includes(ext)) return 'Documents';
  return 'Other';
}

const hashFile = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(filePath).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

const fileSummary = (file) => ({
  _id: file._id,
  originalName: file.originalName,
  size: file.size,
  mimeType: file.mimeType,
  parentFolder: file.parentFolder,
  updatedAt: file.updatedAt,
  category: categoryOf(file.mimeType, file.originalName),
});

/** Files with identical content: same size first, then confirmed by SHA-256. */
async function findDuplicates(files) {
  const bySize = new Map();
  files.filter(f => f.size > 0).forEach(f => bySize.set(f.size, [...(bySize.get(f.size) || []), f]));
  const candidates = [...bySize.values()].filter(group => group.length > 1).flat();

  let hashedBytes = 0;
  let hashedFiles = 0;
  let complete = true;
  const byHash = new Map();
  for (const file of candidates) {
    if (hashedFiles >= MAX_HASH_FILES || hashedBytes + file.size > MAX_HASH_BYTES) { complete = false; break; }
    if (!(await fs.pathExists(file.path))) continue;
    try {
      const digest = await hashFile(file.path);
      byHash.set(digest, [...(byHash.get(digest) || []), file]);
      hashedBytes += file.size;
      hashedFiles += 1;
    } catch {
      // Unreadable file: skip it rather than guess.
    }
  }

  const groups = [...byHash.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      size: group[0].size,
      reclaimableBytes: group[0].size * (group.length - 1),
      files: group.map(fileSummary),
    }))
    .sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  return { groups, complete };
}

async function buildStorageSummary(userId) {
  const [user, allFiles, folderCount, trash] = await Promise.all([
    User.findById(userId).select('storageUsed storageLimit').lean(),
    File.find({ owner: userId, isTrashed: { $ne: true } }).select('originalName size mimeType path parentFolder updatedAt').lean(),
    Folder.countDocuments({ owner: userId, isTrashed: { $ne: true }, isCourseFolder: { $ne: true } }),
    trashSize(userId),
  ]);
  // Files inside a trashed folder are in Trash even though they are not flagged themselves.
  const inTrashedFolder = new Set(trash.folderIds.map(String));
  const files = allFiles.filter(file => !inTrashedFolder.has(String(file.parentFolder)));
  delete trash.folderIds;

  const categories = Object.fromEntries(CATEGORY_ORDER.map(name => [name, { bytes: 0, files: 0 }]));
  let activeBytes = 0;
  const missing = [];
  for (const file of files) {
    const category = categories[categoryOf(file.mimeType, file.originalName)];
    category.bytes += file.size || 0;
    category.files += 1;
    activeBytes += file.size || 0;
    if (!file.path || !(await fs.pathExists(file.path))) missing.push(fileSummary(file));
  }

  // Storage counts files in Trash too, until they are permanently deleted.
  const measuredBytes = activeBytes + trash.bytes;
  const limit = user?.storageLimit || 0;
  const duplicates = await findDuplicates(files);

  return {
    usedBytes: measuredBytes,
    limitBytes: limit,
    percentUsed: limit ? Math.min(100, (measuredBytes / limit) * 100) : 0,
    activeBytes,
    fileCount: files.length,
    folderCount,
    categories: CATEGORY_ORDER.map(name => ({ name, ...categories[name] })),
    largeFiles: [...files].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 10).map(fileSummary),
    trash,
    duplicates,
    missingFiles: missing.slice(0, 50),
    missingFileCount: missing.length,
    // The quota counter on the account; it can drift from the real total after old bugs.
    recordedBytes: user?.storageUsed || 0,
  };
}

/** Reset the account's quota counter to the measured total of its files (including Trash). */
async function recalculateStorage(userId) {
  const [result] = await File.aggregate([
    { $match: { owner: userId } },
    { $group: { _id: null, bytes: { $sum: '$size' } } },
  ]);
  const bytes = result?.bytes || 0;
  await User.updateOne({ _id: userId }, { $set: { storageUsed: bytes } });
  return bytes;
}

module.exports = { buildStorageSummary, recalculateStorage, categoryOf };
