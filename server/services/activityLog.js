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

module.exports = { logFileBoxAction };
