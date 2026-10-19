const Activity = require('../models/Activity');

/**
 * Activity entries for things File Box did on the user's behalf (AI actions, approved suggestions).
 * Logging must never break the action itself, so failures are only reported.
 */
const ACTION_FOR_TYPE = {
  delete_file: 'deleted',
  star_file: 'starred',
  share_file: 'shared',
  move_file: 'moved',
  rename_file: 'renamed',
  restore_file: 'restored',
};

async function logFileBoxAction(userId, type, data = {}) {
  try {
    if (type === 'create_folder' && data.folderId) {
      await Activity.create({ user: userId, folder: data.folderId, action: 'created', details: `Folder: ${data.folderName}`, source: 'filebox' });
      return;
    }
    const action = ACTION_FOR_TYPE[type];
    if (!action || !Array.isArray(data.fileIds)) return;
    const details = type === 'rename_file' && data.newName ? `Renamed to ${data.newName}`
      : type === 'move_file' && data.targetFolder ? `Moved to ${data.targetFolder}`
        : type === 'share_file' && data.sharedWith ? `Shared with ${data.sharedWith}` : '';
    await Activity.insertMany(data.fileIds.map(file => ({ user: userId, file, action, details, source: 'filebox' })));
  } catch (error) {
    console.error('[Activity] Could not log File Box action:', error.message);
  }
}

const VIEW_REPEAT_MS = 10 * 60 * 1000;
const FOCUS_GAP_MS = 2 * 60 * 1000;
const MAX_HEARTBEAT_SECONDS = 60;

/** Opened a file to look at it. Opening it again within 10 minutes counts once. */
async function logView(userId, file) {
  try {
    const recent = await Activity.exists({ user: userId, file: file._id, action: 'viewed', createdAt: { $gte: new Date(Date.now() - VIEW_REPEAT_MS) } });
    if (!recent) await Activity.create({ user: userId, file: file._id, action: 'viewed', details: file.originalName });
  } catch (error) {
    console.error('[Activity] Could not log view:', error.message);
  }
}

/**
 * Time with a file open and visible (heartbeats from the preview or editor). Heartbeats less than
 * 2 minutes apart extend the same sitting, so one long sitting is one entry.
 */
async function logFocus(userId, file, seconds) {
  const add = Math.max(1, Math.min(MAX_HEARTBEAT_SECONDS, Math.round(Number(seconds) || 0)));
  const now = new Date();
  const updated = await Activity.findOneAndUpdate(
    { user: userId, file: file._id, action: 'focused', endedAt: { $gte: new Date(now - FOCUS_GAP_MS) } },
    { $inc: { durationSeconds: add }, $set: { endedAt: now } },
    { sort: { endedAt: -1 }, new: true }
  );
  if (!updated) {
    await Activity.create({ user: userId, file: file._id, action: 'focused', details: file.originalName, durationSeconds: add, endedAt: now, createdAt: new Date(now - add * 1000) });
  }
}

/** A question asked in File Box AI (and the file it was about, if any). */
async function logQuestion(userId, question, fileId = null) {
  try {
    await Activity.create({ user: userId, file: fileId || null, action: 'asked', details: String(question).slice(0, 300) });
  } catch (error) {
    console.error('[Activity] Could not log question:', error.message);
  }
}

module.exports = { logFileBoxAction, logView, logFocus, logQuestion };
