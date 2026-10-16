const mongoose = require('mongoose');
const File = require('../models/File');
const Folder = require('../models/Folder');
const TeamFolder = require('../models/TeamFolder');

/**
 * One place that decides what a user may do with a file or folder.
 *
 * Roles, from most to least access:
 *   owner  - everything: rename, move, copy, trash, delete, share, edit, view
 *   editor - edit contents (new versions), view, download, comment
 *   viewer - view, download, comment
 *   null   - no access (callers answer 404 so existence is not revealed)
 *
 * Access comes from ownership, a direct share (File.sharedWith, honoring expiresAt),
 * or membership of the Team Space the item lives in.
 */

const RANK = { viewer: 1, editor: 2, owner: 3 };
const MAX_FOLDER_DEPTH = 32;

const idOf = (value) => {
  if (!value) return '';
  return (value._id || value).toString();
};

const atLeast = (role, needed) => (RANK[role] || 0) >= RANK[needed];
const higher = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

const isActiveShare = (entry) => !entry.expiresAt || new Date(entry.expiresAt) > new Date();

const shareRole = (item, userId) => {
  const entry = (item.sharedWith || []).find(s => idOf(s.user) === idOf(userId));
  if (!entry || !isActiveShare(entry)) return null;
  return entry.permission === 'edit' ? 'editor' : 'viewer';
};

/** Role inside a Team Space: owner | admin | editor | viewer | null */
const getTeamRole = (team, userId) => {
  if (!team) return null;
  if (idOf(team.owner) === idOf(userId)) return 'owner';
  const member = (team.members || []).find(m => idOf(m.user) === idOf(userId));
  return member ? member.role : null;
};

// What a Team Space role allows on the files and folders inside it.
const teamRoleToItemRole = (teamRole) => {
  if (!teamRole) return null;
  return teamRole === 'viewer' ? 'viewer' : 'editor';
};

/** Walk up the folder chain from `parentId` until a Team Space is found. */
async function findTeamForParent(parentId) {
  let current = parentId;
  for (let depth = 0; current && depth < MAX_FOLDER_DEPTH; depth += 1) {
    const team = await TeamFolder.findById(current);
    if (team) return team;
    const folder = await Folder.findById(current).select('parentFolder').lean();
    if (!folder) return null;
    current = folder.parentFolder;
  }
  return null;
}

async function getFileRole(file, userId) {
  if (!file || !userId) return null;
  if (idOf(file.owner) === idOf(userId)) return 'owner';
  // Trash is private to the owner.
  if (file.isTrashed) return null;

  let role = shareRole(file, userId);
  if (file.parentFolder && !atLeast(role, 'editor')) {
    const team = await findTeamForParent(file.parentFolder);
    role = higher(role, teamRoleToItemRole(getTeamRole(team, userId)));
  }
  return role || null;
}

async function getFolderRole(folder, userId) {
  if (!folder || !userId) return null;
  if (idOf(folder.owner) === idOf(userId)) return 'owner';
  if (folder.isTrashed) return null;
  const team = folder.parentFolder ? await findTeamForParent(folder.parentFolder) : null;
  return teamRoleToItemRole(getTeamRole(team, userId));
}

/** What the UI may offer for a given role. */
const capabilitiesFor = (role) => ({
  role: role || null,
  canView: atLeast(role, 'viewer'),
  canDownload: atLeast(role, 'viewer'),
  canComment: atLeast(role, 'viewer'),
  canEdit: atLeast(role, 'editor'),
  canShare: role === 'owner',
  canRename: role === 'owner',
  canMove: role === 'owner',
  canCopy: role === 'owner',
  canTrash: role === 'owner',
  canViewVersions: atLeast(role, 'editor'),
});

/**
 * Load a file and check the caller has at least `level` access.
 * Returns { file, role } or { status, message } ready to send.
 */
async function authorizeFile(fileId, userId, level = 'viewer') {
  if (!mongoose.isValidObjectId(fileId)) return { status: 404, message: 'File not found' };
  const file = await File.findById(fileId);
  const role = await getFileRole(file, userId);
  if (!file || !role) return { status: 404, message: 'File not found' };
  if (!atLeast(role, level)) {
    return { status: 403, message: level === 'owner' ? 'Only the owner can do this' : 'You do not have permission to do this' };
  }
  return { file, role };
}

async function authorizeFolder(folderId, userId, level = 'viewer') {
  if (!mongoose.isValidObjectId(folderId)) return { status: 404, message: 'Folder not found' };
  const folder = await Folder.findById(folderId);
  const role = await getFolderRole(folder, userId);
  if (!folder || !role) return { status: 404, message: 'Folder not found' };
  if (!atLeast(role, level)) return { status: 403, message: 'You do not have permission to do this' };
  return { folder, role };
}

/**
 * Mongo filter for files a user can read (used by search and File Box AI).
 * Covers owned files, active direct shares, and files directly inside the user's Team Spaces.
 */
async function readableFileFilter(userId) {
  const teams = await TeamFolder.find({ $or: [{ owner: userId }, { 'members.user': userId }] }).select('_id').lean();
  return {
    isTrashed: { $ne: true },
    $or: [
      { owner: userId },
      { sharedWith: { $elemMatch: { user: userId, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] } } },
      ...(teams.length ? [{ parentFolder: { $in: teams.map(t => t._id) } }] : []),
    ],
  };
}

/** Send the error part of an authorize* result. Returns true when a response was sent. */
const sendDenied = (res, result) => {
  if (!result.status) return false;
  res.status(result.status).json({ message: result.message });
  return true;
};

module.exports = {
  atLeast,
  getFileRole,
  getFolderRole,
  getTeamRole,
  findTeamForParent,
  capabilitiesFor,
  authorizeFile,
  authorizeFolder,
  readableFileFilter,
  sendDenied,
  isActiveShare,
};
