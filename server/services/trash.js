const fs = require('fs-extra');
const File = require('../models/File');
const Folder = require('../models/Folder');
const User = require('../models/User');
const FileContent = require('../models/FileContent');
const Share = require('../models/Share');
const { deleteAllVersions } = require('./fileVersions');

// Items stay in Trash this long before they are permanently deleted.
const RECOVERY_DAYS = 30;

/** Permanently delete one file: contents, versions, links, extracted text, and its storage. */
async function purgeFile(file) {
  if (file.path && (await fs.pathExists(file.path))) await fs.remove(file.path);
  await deleteAllVersions(file._id);
  await Promise.all([
    FileContent.deleteMany({ file: file._id }),
    Share.deleteMany({ file: file._id }),
  ]);
  await User.updateOne({ _id: file.owner }, { $inc: { storageUsed: -(file.size || 0) } });
  await User.updateOne({ _id: file.owner, storageUsed: { $lt: 0 } }, { $set: { storageUsed: 0 } });
  await file.deleteOne();
}

/** Permanently delete a folder and everything inside it. Returns counts. */
async function purgeFolderTree(folder) {
  let files = 0;
  let folders = 0;
  const queue = [folder._id];
  const toDelete = [];

  while (queue.length) {
    const id = queue.shift();
    toDelete.push(id);
    const children = await Folder.find({ parentFolder: id }).select('_id').lean();
    queue.push(...children.map(child => child._id));
  }

  for (const folderId of toDelete) {
    const contained = await File.find({ parentFolder: folderId });
    for (const file of contained) {
      await purgeFile(file);
      files += 1;
    }
  }
  const result = await Folder.deleteMany({ _id: { $in: toDelete } });
  folders = result.deletedCount;
  return { files, folders };
}

/** Bytes a user's Trash holds: trashed files plus files inside trashed folders. */
async function trashSize(userId) {
  const trashedFolders = await Folder.find({ owner: userId, isTrashed: true }).select('_id').lean();
  const folderIds = [];
  const queue = trashedFolders.map(f => f._id);
  while (queue.length) {
    const id = queue.shift();
    folderIds.push(id);
    const children = await Folder.find({ parentFolder: id }).select('_id').lean();
    queue.push(...children.map(child => child._id));
  }
  const [result] = await File.aggregate([
    { $match: { owner: userId, $or: [{ isTrashed: true }, { parentFolder: { $in: folderIds } }] } },
    { $group: { _id: null, bytes: { $sum: '$size' }, count: { $sum: 1 } } },
  ]);
  return { bytes: result?.bytes || 0, files: result?.count || 0, folders: trashedFolders.length, folderIds };
}

/** Empty one user's Trash, or (without userId) purge everything past the recovery period. */
async function purgeTrash({ userId, olderThanDays } = {}) {
  const query = { isTrashed: true };
  if (userId) query.owner = userId;
  if (olderThanDays) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    query.deletedAt = { $lte: cutoff };
  }

  let files = 0;
  let folders = 0;
  for (const folder of await Folder.find(query)) {
    const counts = await purgeFolderTree(folder);
    files += counts.files;
    folders += counts.folders;
  }
  for (const file of await File.find(query)) {
    await purgeFile(file);
    files += 1;
  }
  return { files, folders };
}

module.exports = { RECOVERY_DAYS, purgeFile, purgeFolderTree, purgeTrash, trashSize };
