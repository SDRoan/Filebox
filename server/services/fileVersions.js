const path = require('path');
const fs = require('fs-extra');
const FileVersion = require('../models/FileVersion');
const User = require('../models/User');

/**
 * Version history keeps an immutable copy of each previous file content under
 * server/uploads/<ownerId>/versions/. The live file can then be replaced or deleted
 * without breaking older versions. Versions do not count toward storage usage.
 */

const versionsDir = (file) => path.join(__dirname, '..', 'uploads', file.owner.toString(), 'versions');

async function nextVersionNumber(fileId) {
  const latest = await FileVersion.findOne({ file: fileId }).sort({ versionNumber: -1 }).select('versionNumber').lean();
  return latest ? latest.versionNumber + 1 : 1;
}

/** Copy the file's current contents into a new version record. Returns the version, or null if there is nothing on disk. */
async function snapshotCurrentVersion(file, userId, changeDescription = '') {
  if (!file.path || !(await fs.pathExists(file.path))) return null;

  const dir = versionsDir(file);
  await fs.ensureDir(dir);
  const copyPath = path.join(dir, `${file._id}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.path)}`);
  await fs.copy(file.path, copyPath);

  return FileVersion.create({
    file: file._id,
    versionNumber: await nextVersionNumber(file._id),
    path: copyPath,
    size: file.size,
    uploadedBy: userId,
    changeDescription,
  });
}

/**
 * Point the file at new contents (already written to `newPath`), remove the old live copy,
 * and keep the owner's storage usage in step with the size change.
 */
async function replaceFileContents(file, newPath, newSize) {
  const oldPath = file.path;
  const sizeDelta = newSize - (file.size || 0);

  file.path = newPath;
  file.size = newSize;
  file.updatedAt = new Date();
  await file.save();

  if (oldPath && oldPath !== newPath && (await fs.pathExists(oldPath))) {
    await fs.remove(oldPath);
  }
  if (sizeDelta) {
    await User.updateOne({ _id: file.owner }, { $inc: { storageUsed: sizeDelta } });
  }
}

/** Delete every stored version of a file (used when the file is permanently deleted). */
async function deleteAllVersions(fileId) {
  const versions = await FileVersion.find({ file: fileId }).select('path').lean();
  for (const version of versions) {
    if (version.path && (await fs.pathExists(version.path))) await fs.remove(version.path);
  }
  await FileVersion.deleteMany({ file: fileId });
}

/** Where new live contents for a file should be written. */
const newLivePath = (file, extension) => path.join(
  __dirname, '..', 'uploads', file.owner.toString(),
  `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
);

module.exports = { snapshotCurrentVersion, replaceFileContents, deleteAllVersions, newLivePath };
