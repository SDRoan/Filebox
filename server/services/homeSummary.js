const fs = require('fs-extra');
const File = require('../models/File');
const Folder = require('../models/Folder');
const Activity = require('../models/Activity');
const { readableFileFilter, filterReadable } = require('./permissions');
const { trashSize, RECOVERY_DAYS } = require('./trash');
const { findDuplicates } = require('./storageSummary');
const { ruleProposals } = require('./organizeSuggestions');

/**
 * Everything the Home page needs, from local data only. No Ollama call, no network:
 * Home stays fast and works when File Box AI is offline.
 */

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const MAX_SUGGESTIONS = 3;
const EXPIRING_WITHIN_DAYS = 3;
const MB = 1024 * 1024;

// How much each kind of interaction says "I'm working on this".
const WEIGHTS = {
  edited: 3, version_restored: 3, version_created: 3,
  viewed: 2, downloaded: 2, shared: 2, shared_with_you: 2.5, commented: 2,
  restored: 1.5, starred: 1.5, uploaded: 1, renamed: 1, copied: 1, moved: 0.5,
  filebox: 2,
};
const ACCESS_ACTIONS = { view: 'viewed', download: 'downloaded', edit: 'edited' };

const formatBytes = (bytes = 0) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ Continue working */

async function continueWorking(userId, limit = 8) {
  const since = new Date(Date.now() - WINDOW_DAYS * DAY);
  const uid = userId.toString();
  const events = new Map(); // fileId -> [{ action, at, source }]
  const add = (fileId, action, at, source = 'user') => {
    if (!fileId || !at || new Date(at) < since) return;
    const key = fileId.toString();
    if (!events.has(key)) events.set(key, []);
    events.get(key).push({ action, at: new Date(at), source });
  };

  const [activities, viewed, sharing, uploads] = await Promise.all([
    Activity.find({ user: userId, file: { $ne: null }, createdAt: { $gte: since } }).select('file action source createdAt').lean(),
    File.find({ accessLog: { $elemMatch: { userId, timestamp: { $gte: since } } }, isTrashed: { $ne: true } }).select('accessLog').lean(),
    File.find({ isTrashed: { $ne: true }, $or: [{ owner: userId, 'sharedWith.0': { $exists: true } }, { 'sharedWith.user': userId }] }).select('owner sharedWith').lean(),
    File.find({ owner: userId, isTrashed: { $ne: true }, createdAt: { $gte: since } }).select('createdAt').lean(),
  ]);

  activities.forEach(a => {
    if (a.action === 'deleted') return; // trashing isn't "working on it"
    add(a.file, a.source === 'filebox' ? 'filebox' : a.action, a.createdAt, a.source);
  });
  viewed.forEach(f => (f.accessLog || [])
    .filter(e => e.userId?.toString() === uid && ACCESS_ACTIONS[e.action])
    .forEach(e => add(f._id, ACCESS_ACTIONS[e.action], e.timestamp)));
  // Shares are logged in Activity since Phase 4A; share entries cover older shares without double counting.
  const loggedShares = new Set(activities.filter(a => a.action === 'shared').map(a => a.file.toString()));
  sharing.forEach(f => {
    const mine = f.owner.toString() === uid;
    if (mine && loggedShares.has(f._id.toString())) return;
    (f.sharedWith || [])
      .filter(e => mine || e.user?.toString() === uid)
      .forEach(e => add(f._id, mine ? 'shared' : 'shared_with_you', e._id.getTimestamp()));
  });
  uploads.forEach(f => add(f._id, 'uploaded', f.createdAt));

  const now = Date.now();
  const scored = [...events.entries()].map(([fileId, list]) => {
    // Recent interactions count most; each decays with a one-week half-life.
    const score = list.reduce((sum, e) => sum + (WEIGHTS[e.action] || 0.5) * Math.pow(0.5, (now - e.at) / (7 * DAY)), 0);
    const latest = list.reduce((a, b) => (a.at > b.at ? a : b));
    return { fileId, score, latest };
  }).sort((a, b) => b.score - a.score);

  if (!scored.length) return [];
  // Only files the user can still open, via the same permission rules as everything else.
  const files = await File.find({ ...(await readableFileFilter(userId)), _id: { $in: scored.slice(0, 60).map(s => s.fileId) } })
    .populate('owner', 'name email');
  const readable = new Map((await filterReadable(files, userId)).map(({ file, access }) => [file._id.toString(), { file, access }]));

  return scored
    .filter(s => readable.has(s.fileId))
    .slice(0, limit)
    .map(s => {
      const { file, access } = readable.get(s.fileId);
      const item = file.toObject();
      if (access.role !== 'owner') {
        delete item.path;
        delete item.sharedWith;
        delete item.accessLog;
      }
      return { ...item, access, lastInteraction: s.latest.action, lastInteractionAt: s.latest.at, lastInteractionBy: s.latest.source };
    });
}

/* ------------------------------------------------------------------ Suggestions */

async function suggestions(userId) {
  const active = await File.find({ owner: userId, isTrashed: { $ne: true } })
    .select('originalName size mimeType path parentFolder createdAt updatedAt').lean();
  const trash = await trashSize(userId);
  const inTrashedFolder = new Set(trash.folderIds.map(String));
  const files = active.filter(f => !inTrashedFolder.has(String(f.parentFolder)));
  const cutoff = new Date(Date.now() - (RECOVERY_DAYS - EXPIRING_WITHIN_DAYS) * DAY);
  const [expiringFiles, expiringFolders, rootFolders] = await Promise.all([
    File.countDocuments({ owner: userId, isTrashed: true, deletedAt: { $lte: cutoff } }),
    Folder.countDocuments({ owner: userId, isTrashed: true, deletedAt: { $lte: cutoff } }),
    Folder.find({ owner: userId, isTrashed: { $ne: true }, parentFolder: null, isCourseFolder: { $ne: true } }).select('name').lean(),
  ]);

  const list = [];

  // 1. Files whose contents are gone (data integrity first)
  const missing = [];
  for (const file of files.slice(0, 2000)) {
    if (!file.path || !(await fs.pathExists(file.path))) missing.push(file);
  }
  if (missing.length) {
    list.push({
      id: 'missing-files',
      fingerprint: `${missing.length}`,
      noticed: `${plural(missing.length, 'file')} can't be opened`,
      why: "Their contents are no longer on this computer, so they can't be previewed or downloaded.",
      recommendation: 'Review them on the Storage page and move broken entries to Trash.',
      action: { label: 'Review files', type: 'navigate', to: 'storage' },
    });
  }

  // 2. Trash items about to be deleted forever
  const expiring = expiringFiles + expiringFolders;
  if (expiring) {
    list.push({
      id: 'trash-expiring',
      fingerprint: `${expiring}`,
      noticed: `${plural(expiring, 'item')} in Trash will be deleted forever within ${EXPIRING_WITHIN_DAYS} days`,
      why: `Items in Trash are permanently deleted ${RECOVERY_DAYS} days after you delete them.`,
      recommendation: 'Restore anything you still need.',
      action: { label: 'Open Trash', type: 'navigate', to: 'trash' },
    });
  }

  // 3. Identical copies (small checksum budget so Home stays fast)
  const { groups } = await findDuplicates(files, { maxFiles: 100, maxBytes: 64 * MB });
  if (groups.length) {
    const extra = groups.reduce((n, g) => n + g.files.length - 1, 0);
    const bytes = groups.reduce((n, g) => n + g.reclaimableBytes, 0);
    list.push({
      id: 'duplicates',
      fingerprint: groups.map(g => g.files.map(f => f._id).join(',')).join('|'),
      noticed: `${plural(extra, 'duplicate file')} found`,
      why: `Identical copies use ${formatBytes(bytes)} of storage.`,
      recommendation: 'Review which copy to keep. Nothing is removed until you confirm.',
      action: { label: 'Review duplicates', type: 'duplicates' },
    });
  }

  // 4. Things the organize rules would group, in My Files
  const proposals = ruleProposals(files.filter(f => !f.parentFolder), rootFolders);
  const moves = proposals.filter(p => p.type === 'move');
  if (moves.length) {
    const byFolder = moves.reduce((m, p) => m.set(p.folderName, (m.get(p.folderName) || 0) + 1), new Map());
    const [topFolder, topCount] = [...byFolder.entries()].sort((a, b) => b[1] - a[1])[0];
    const isShots = topFolder === 'Screenshots';
    list.push({
      id: 'organize',
      fingerprint: moves.map(p => p.fileId).sort().join(','),
      noticed: isShots ? `${plural(topCount, 'screenshot')} could be organized` : `${topCount} files starting with "${topFolder}" could go in one folder`,
      why: 'Grouping related files keeps My Files easier to scan.',
      recommendation: 'Let File Box suggest folders. You choose what to apply.',
      action: { label: 'Let File Box organize this', type: 'organize' },
    });
  }

  // 5. Trash taking real space
  const activeBytes = files.reduce((n, f) => n + (f.size || 0), 0);
  const used = activeBytes + trash.bytes;
  if (trash.bytes >= 5 * MB && (trash.bytes >= 50 * MB || trash.bytes / used >= 0.2)) {
    list.push({
      id: 'trash-size',
      fingerprint: `${Math.round(trash.bytes / MB)}`,
      noticed: `Trash holds ${formatBytes(trash.bytes)}`,
      why: "Items in Trash still count toward your storage until they're deleted.",
      recommendation: 'Restore what you need, then empty Trash.',
      action: { label: 'Open Trash', type: 'navigate', to: 'trash' },
    });
  }

  // 6. One file, or a few, taking most of the space
  const largest = [...files].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 5);
  const largestBytes = largest.reduce((n, f) => n + (f.size || 0), 0);
  const top = largest[0];
  if (top && used && top.size >= 10 * MB && top.size / used >= 0.5) {
    list.push({
      id: 'large-files',
      fingerprint: `${top._id}`,
      noticed: `"${top.originalName}" uses ${Math.round((top.size / used) * 100)}% of your storage`,
      why: `It takes ${formatBytes(top.size)} on its own.`,
      recommendation: 'Review your largest files and keep what you need.',
      action: { label: 'Review large files', type: 'navigate', to: 'storage' },
    });
  } else if (files.length > largest.length && largestBytes >= 10 * MB && used && largestBytes / used >= 0.5) {
    list.push({
      id: 'large-files',
      fingerprint: largest.map(f => f._id).join(','),
      noticed: `${plural(largest.length, 'file')} use ${Math.round((largestBytes / used) * 100)}% of your storage`,
      why: `Together they take ${formatBytes(largestBytes)}.`,
      recommendation: 'Review your largest files and keep what you need.',
      action: { label: 'Review large files', type: 'navigate', to: 'storage' },
    });
  }

  // All candidates, most important first. Home shows the first MAX_SUGGESTIONS the user hasn't dismissed,
  // so dismissing a card can reveal the next one.
  return { suggestions: list, available: list.length };
}

/* ------------------------------------------------------------------ Activity */

async function recentActivity(userId, limit = 10) {
  const entries = await Activity.find({ user: userId }).sort({ createdAt: -1 }).limit(60)
    .populate('file', 'originalName').populate('folder', 'name').lean();

  // Collapse bursts of the same File Box action ("File Box organized 4 files into Screenshots").
  const items = [];
  for (const e of entries) {
    if (!e.file && !e.folder) continue;
    const prev = items[items.length - 1];
    if (prev && e.source === 'filebox' && prev.source === 'filebox' && prev.action === e.action
      && prev.details === e.details && Math.abs(new Date(prev.createdAt) - new Date(e.createdAt)) < 5 * 60 * 1000) {
      prev.count += 1;
      continue;
    }
    items.push({
      _id: e._id,
      action: e.action,
      source: e.source || 'user',
      details: e.details || '',
      fileName: e.file?.originalName || null,
      folderName: e.folder?.name || null,
      createdAt: e.createdAt,
      count: 1,
    });
    if (items.length >= limit) break;
  }
  return items;
}

async function buildHome(userId) {
  const [continueList, suggestionResult, activity] = await Promise.all([
    continueWorking(userId),
    suggestions(userId),
    recentActivity(userId),
  ]);
  return {
    continueWorking: continueList,
    suggestions: suggestionResult.suggestions,
    suggestionsAvailable: suggestionResult.available,
    maxVisibleSuggestions: MAX_SUGGESTIONS,
    activity,
    generatedAt: new Date(),
  };
}

module.exports = { buildHome, continueWorking, suggestions, recentActivity, MAX_SUGGESTIONS };
