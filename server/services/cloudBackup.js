const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const mime = require('mime-types');
const File = require('../models/File');
const Folder = require('../models/Folder');
const CloudBackup = require('../models/CloudBackup');
const User = require('../models/User');
const appConfig = require('../config/appConfig');
const { extractNow } = require('./backgroundExtraction');

/**
 * Folder Sync: copies a folder from the computer File Box runs on into the user's File Box, then
 * keeps it up to date on a schedule (new and changed files only). It is a one-way copy on the same
 * computer, not an off-site backup, and deleting a file from the folder does not delete the copy.
 *
 * Safety:
 *  - only folders inside the approved roots (config folderSync.roots) can be synced, never File Box's
 *    own folders, and links are not followed out of the folder;
 *  - a sync only runs for the account that set it up;
 *  - copies count against the storage limit, and replacing a changed file frees the old copy;
 *  - files that are only in iCloud (not downloaded to this computer) are skipped, so a sync never
 *    makes macOS download a whole folder.
 */

const APP_DIR = path.resolve(__dirname, '..', '..');
const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');
const SKIP_NAMES = new Set(['node_modules', '__pycache__', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN']);
const running = new Set(); // sync ids in progress

const pathError = (message) => Object.assign(new Error(message), { status: 400 });
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// A file whose contents are only in iCloud has a size but no blocks on this disk.
const isCloudOnly = (stats) => stats.size > 0 && stats.blocks === 0;

class CloudBackupService {
  isEnabled() {
    return appConfig.folderSync.enabled;
  }

  approvedRoots() {
    return appConfig.folderSync.roots.map(root => path.resolve(root));
  }

  /** Desktop and Documents, when they are inside an approved root. */
  getDefaultBackupPaths() {
    const homeDir = os.homedir();
    return {
      desktop: path.join(homeDir, 'Desktop'),
      documents: path.join(homeDir, 'Documents'),
    };
  }

  /**
   * The real path of a folder that may be synced, or an error saying why not.
   * Links are resolved first, so a link cannot point the sync somewhere else.
   */
  async approvedFolder(sourcePath) {
    if (!this.isEnabled()) throw Object.assign(new Error('Folder Sync is turned off on this File Box.'), { status: 403 });
    if (!sourcePath || !path.isAbsolute(String(sourcePath))) throw pathError('Enter the full path of a folder, for example /Users/you/Documents.');
    let real;
    try {
      real = await fs.realpath(path.resolve(String(sourcePath)));
    } catch {
      throw pathError('That folder does not exist on this computer.');
    }
    const stats = await fs.stat(real).catch(() => null);
    if (!stats || !stats.isDirectory()) throw pathError('That path is not a folder.');

    const roots = this.approvedRoots();
    const root = roots.find(candidate => inside(real, candidate));
    if (!root) throw pathError(`Only folders inside ${roots.join(' or ')} can be synced.`);
    if (real === root) throw pathError('Choose a folder inside your home folder, not the whole home folder.');
    if (inside(real, path.join(os.homedir(), 'Library'))) throw pathError('System folders (Library) cannot be synced.');
    if (inside(real, APP_DIR) || inside(APP_DIR, real) || inside(UPLOADS_DIR, real)) {
      throw pathError('This folder contains File Box itself, so it cannot be synced into File Box.');
    }
    try {
      await fs.readdir(real);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        throw Object.assign(new Error(`File Box does not have permission to read ${real}. On a Mac, allow it in System Settings > Privacy & Security > Files and Folders.`), { status: 403 });
      }
      throw error;
    }
    return real;
  }

  /** Whether a folder could be synced (for showing the Desktop / Documents choices). */
  async checkPathExists(sourcePath) {
    try {
      await this.approvedFolder(sourcePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Create or update a sync. The folder is checked against the approved roots. */
  async createOrUpdateBackup(userId, sourceType, sourcePath, options = {}) {
    const real = await this.approvedFolder(sourcePath);
    const settings = {
      sourceType,
      sourcePath: real,
      enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
      backupFrequency: ['hourly', 'daily', 'weekly'].includes(options.backupFrequency) ? options.backupFrequency : 'daily',
      updatedAt: new Date(),
    };
    const existing = await CloudBackup.findOne({ user: userId, sourcePath: real });
    if (existing) {
      Object.assign(existing, settings);
      return existing.save();
    }
    return new CloudBackup({ user: userId, ...settings }).save();
  }

  /** Start a sync without waiting for it (the page shows progress). Only the account's own syncs. */
  async startBackup(backupId, userId) {
    const backup = await CloudBackup.findOne({ _id: backupId, user: userId });
    if (!backup) throw Object.assign(new Error('Sync not found.'), { status: 404 });
    if (running.has(String(backup._id))) return backup;
    await this.approvedFolder(backup.sourcePath); // fail fast with a clear message
    backup.status = 'backing_up';
    backup.lastError = null;
    await backup.save();
    this.performBackup(backup._id, userId).catch(() => {});
    return backup;
  }

  /** Run one sync to completion. `userId` must be the account that set it up. */
  async performBackup(backupId, userId) {
    const id = String(backupId);
    if (running.has(id)) throw new Error('This folder is already syncing.');
    const backup = await CloudBackup.findOne({ _id: backupId, user: userId });
    if (!backup) throw Object.assign(new Error('Sync not found.'), { status: 404 });

    running.add(id);
    backup.status = 'backing_up';
    await backup.save();
    try {
      const source = await this.approvedFolder(backup.sourcePath);
      const user = await User.findById(userId);
      if (!user) throw new Error('The account for this sync no longer exists.');

      const folderName = `Synced – ${backup.sourceType === 'desktop' ? 'Desktop' : backup.sourceType === 'documents' ? 'Documents' : path.basename(source)}`;
      let syncFolder = await Folder.findOne({ owner: userId, name: folderName, parentFolder: null, isTrashed: false });
      if (!syncFolder) syncFolder = await new Folder({ name: folderName, owner: userId, parentFolder: null }).save();

      const run = {
        userId,
        storageUsed: user.storageUsed || 0,
        storageLimit: user.storageLimit,
        toRead: [],
        result: { copied: 0, updated: 0, unchanged: 0, skippedCloudOnly: 0, skippedQuota: 0, skippedOther: 0 },
        bytes: 0,
      };
      await this.syncDirectory(source, syncFolder._id, run);

      const { result } = run;
      backup.status = 'completed';
      backup.lastBackupAt = new Date();
      backup.backupCount += 1;
      backup.totalFilesBackedUp += result.copied + result.updated;
      backup.totalSizeBackedUp += run.bytes;
      backup.lastResult = { ...result, at: new Date() };
      backup.lastError = result.skippedQuota
        ? `${result.skippedQuota} file${result.skippedQuota === 1 ? ' was' : 's were'} not copied because your storage is full.`
        : null;
      backup.nextBackupAt = this.calculateNextBackupTime(backup.backupFrequency);
      await backup.save();
      console.log(`[Folder Sync] ${source}: ${JSON.stringify(result)}`);

      // Let File Box AI read the copied files, one at a time so a large folder does not swamp the computer.
      this.readCopies(run.toRead);
      return { success: true, ...result, totalSize: run.bytes, backupId: backup._id };
    } catch (error) {
      backup.status = 'failed';
      backup.lastError = error.message;
      backup.nextBackupAt = this.calculateNextBackupTime(backup.backupFrequency);
      await backup.save();
      throw error;
    } finally {
      running.delete(id);
    }
  }

  async readCopies(files) {
    for (const file of files) await extractNow(file);
  }

  /** Copy new and changed files from one folder (and its subfolders) into a File Box folder. */
  async syncDirectory(sourcePath, parentFolderId, run) {
    const items = await fs.readdir(sourcePath).catch(() => []);
    for (const item of items) {
      if (item.startsWith('.') || SKIP_NAMES.has(item)) continue;
      const itemPath = path.join(sourcePath, item);
      const stats = await fs.lstat(itemPath).catch(() => null);
      if (!stats || stats.isSymbolicLink()) continue; // links are not followed out of the folder

      if (stats.isDirectory()) {
        let folder = await Folder.findOne({ owner: run.userId, name: item, parentFolder: parentFolderId, isTrashed: false });
        if (!folder) folder = await new Folder({ name: item, owner: run.userId, parentFolder: parentFolderId }).save();
        await this.syncDirectory(itemPath, folder._id, run);
      } else if (stats.isFile()) {
        await this.syncFile(itemPath, item, stats, parentFolderId, run);
      }
    }
  }

  async syncFile(itemPath, name, stats, parentFolderId, run) {
    const { result } = run;
    const existing = await File.findOne({ owner: run.userId, parentFolder: parentFolderId, originalName: name, isTrashed: false });
    if (existing) {
      // A file with this name that File Box did not copy here is the user's own: leave it alone.
      if (!existing.syncedFrom?.path) { result.skippedOther += 1; return; }
      if (existing.syncedFrom.mtimeMs === stats.mtimeMs && existing.syncedFrom.size === stats.size) { result.unchanged += 1; return; }
    }
    if (isCloudOnly(stats)) { result.skippedCloudOnly += 1; return; }

    const growth = stats.size - (existing ? existing.size : 0);
    if (run.storageUsed + growth > run.storageLimit) { result.skippedQuota += 1; return; }

    const userDir = path.join(UPLOADS_DIR, String(run.userId));
    await fs.ensureDir(userDir);
    const ext = path.extname(name);
    const destName = `${path.basename(name, ext)}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const destPath = path.join(userDir, destName);
    try {
      await fs.copyFile(itemPath, destPath);
    } catch (error) {
      await fs.remove(destPath).catch(() => {});
      result.skippedOther += 1;
      console.error(`[Folder Sync] Could not copy ${itemPath}:`, error.message);
      return;
    }

    const syncedFrom = { path: itemPath, mtimeMs: stats.mtimeMs, size: stats.size };
    const mimeType = mime.lookup(name) || 'application/octet-stream';
    let file;
    if (existing) {
      const oldPath = existing.path;
      Object.assign(existing, { name: destName, path: destPath, size: stats.size, mimeType, syncedFrom, updatedAt: new Date() });
      file = await existing.save();
      // The replaced copy is no longer used: free its space (only File Box's own copies are removed).
      if (oldPath && oldPath !== destPath && inside(path.resolve(oldPath), UPLOADS_DIR)) await fs.remove(oldPath).catch(() => {});
      result.updated += 1;
    } else {
      file = await new File({
        name: destName, originalName: name, path: destPath, size: stats.size, mimeType,
        owner: run.userId, parentFolder: parentFolderId, syncedFrom,
      }).save();
      result.copied += 1;
    }
    await User.updateOne({ _id: run.userId }, { $inc: { storageUsed: growth } });
    run.storageUsed += growth;
    run.bytes += stats.size;
    run.toRead.push(file);
  }

  calculateNextBackupTime(frequency) {
    const next = new Date();
    switch (frequency) {
      case 'hourly':
        next.setHours(next.getHours() + 1);
        break;
      case 'weekly':
        next.setDate(next.getDate() + 7);
        next.setHours(2, 0, 0, 0);
        break;
      default: // daily, at 2 AM
        next.setDate(next.getDate() + 1);
        next.setHours(2, 0, 0, 0);
    }
    return next;
  }

  async getUserBackups(userId) {
    return CloudBackup.find({ user: userId }).sort({ createdAt: -1 });
  }

  /** Stop syncing a folder. Files already copied stay in File Box. */
  async deleteBackup(backupId, userId) {
    const backup = await CloudBackup.findOne({ _id: backupId, user: userId });
    if (!backup) throw Object.assign(new Error('Sync not found.'), { status: 404 });
    await backup.deleteOne();
    return true;
  }

  /** Syncs left "in progress" by a server restart are marked as stopped. */
  async resetInterrupted() {
    await CloudBackup.updateMany({ status: 'backing_up' }, { $set: { status: 'failed', lastError: 'Stopped when File Box restarted. Run it again to finish.' } });
  }
}

module.exports = new CloudBackupService();
