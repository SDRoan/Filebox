const path = require('path');
const File = require('../models/File');
const Folder = require('../models/Folder');
const FileContent = require('../models/FileContent');
const Activity = require('../models/Activity');
const config = require('../config/aiConfig');
const ollamaClient = require('./ollamaClient');
const { authorizeFile, authorizeFolder } = require('./permissions');

/**
 * Organization suggestions: analyze -> propose -> user reviews -> user confirms -> apply.
 * Proposals only touch files the user owns, inside one folder (or My Files). Nothing is applied here
 * without applyProposals() being called with confirm: true, and every action is re-authorized then.
 */

const MAX_FILES = 200;
const SCREENSHOT = /^(screen ?shot|screenshot|capture|scr)[\s_\-]|^screen shot \d|^screenshot \d/i;
const VAGUE = /^(img|dsc|dscn|pxl|photo|image|scan|scanned|document|doc|untitled|new document|file|download|unnamed|copy of|whatsapp image)?[\s_\-]*\(?\d*\)?$/i;
const STOP = new Set(['the', 'and', 'for', 'copy', 'final', 'new', 'old', 'draft', 'img', 'dsc', 'scan', 'file', 'document', 'untitled', 'v1', 'v2', 'v3']);

const stem = (name) => path.parse(name).name;
const extOf = (name) => path.parse(name).ext;
const isVagueName = (name) => VAGUE.test(stem(name).trim()) || /^\d+$/.test(stem(name).trim());

const cleanFolderName = (value = '') => String(value).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanFileStem = (value = '') => String(value).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

const firstWord = (name) => {
  const word = stem(name).split(/[\s_\-.]+/).find(Boolean) || '';
  return /^[a-z]{3,}$/i.test(word) && !STOP.has(word.toLowerCase()) ? word : '';
};

const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/** Rule-based proposals: work without Ollama. */
function ruleProposals(files, folderNames) {
  const proposals = [];
  const existing = new Map(folderNames.map(f => [f.name.toLowerCase(), f]));
  const move = (file, folderName, reason) => {
    const folder = existing.get(folderName.toLowerCase());
    proposals.push({ type: 'move', fileId: file._id, folderId: folder?._id || null, folderName: folder?.name || folderName, isNewFolder: !folder, reason, source: 'rule' });
  };

  const screenshots = files.filter(f => SCREENSHOT.test(f.originalName));
  if (screenshots.length >= 2) {
    screenshots.forEach(f => move(f, 'Screenshots', `One of ${screenshots.length} screenshots in this folder; grouping them keeps your files easier to scan.`));
  }

  const moved = new Set(proposals.map(p => p.fileId.toString()));
  const byPrefix = new Map();
  files.filter(f => !moved.has(f._id.toString())).forEach(f => {
    const word = firstWord(f.originalName);
    if (word) byPrefix.set(word.toLowerCase(), [...(byPrefix.get(word.toLowerCase()) || []), f]);
  });
  for (const group of byPrefix.values()) {
    if (group.length < 3) continue;
    const word = firstWord(group[0].originalName);
    const label = word.charAt(0).toUpperCase() + word.slice(1);
    group.forEach(f => move(f, label, `${group.length} files start with "${word}"; they likely belong together.`));
  }

  // Camera-style names on images get a date name; that's honest without reading the image.
  files.filter(f => (f.mimeType || '').startsWith('image/') && isVagueName(f.originalName) && !SCREENSHOT.test(f.originalName)).forEach(f => {
    proposals.push({ type: 'rename', fileId: f._id, newName: `Photo ${isoDay(f.createdAt)}${extOf(f.originalName)}`, reason: `"${f.originalName}" doesn't describe the photo; the date it was added is more useful.`, source: 'rule' });
  });

  return proposals;
}

const stripFences = (value = '') => value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

/** Ollama proposals: topic folders and better names for vague files. Validated before use. */
async function aiProposals(files, folderNames, taken) {
  const candidates = files.filter(f => !taken.has(f._id.toString())).slice(0, 60);
  if (!candidates.length) return [];

  const contents = await FileContent.find({ file: { $in: candidates.map(f => f._id) } }).select('file extractedText').lean();
  const snippets = new Map(contents.map(c => [c.file.toString(), (c.extractedText || '').replace(/\s+/g, ' ').slice(0, 160)]));
  const list = candidates.map((f, index) => ({
    index,
    name: f.originalName,
    type: f.mimeType,
    snippet: snippets.get(f._id.toString()) || '',
    vagueName: isVagueName(f.originalName),
  }));

  const raw = await ollamaClient.chatText({
    model: config.ollama.plannerModel,
    system: `You help organize files in a cloud drive. Return JSON only, shaped as
{"moves":[{"index":0,"folder":"Folder name","reason":"short reason"}],"renames":[{"index":0,"name":"new name without extension","reason":"short reason"}]}
Rules: suggest a move only when 2 or more files clearly share a topic, using a short folder name (prefer an existing folder). Suggest renames only for files marked vagueName=true, based on their snippet; skip any file you are unsure about. Never invent content. Empty arrays are fine.`,
    content: JSON.stringify({ existingFolders: folderNames.map(f => f.name), files: list }),
    task: 'organize',
    format: 'json',
  });

  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return [];
  }

  const existing = new Map(folderNames.map(f => [f.name.toLowerCase(), f]));
  const proposals = [];
  const used = new Set();
  const moves = Array.isArray(parsed.moves) ? parsed.moves : [];
  const folderCounts = new Map();
  moves.forEach(m => { const name = cleanFolderName(m?.folder).toLowerCase(); if (name) folderCounts.set(name, (folderCounts.get(name) || 0) + 1); });

  for (const m of moves) {
    const file = candidates[m?.index];
    const folderName = cleanFolderName(m?.folder);
    if (!file || !folderName || used.has(file._id.toString())) continue;
    const folder = existing.get(folderName.toLowerCase());
    // A new folder for a single file isn't organizing anything.
    if (!folder && (folderCounts.get(folderName.toLowerCase()) || 0) < 2) continue;
    used.add(file._id.toString());
    proposals.push({ type: 'move', fileId: file._id, folderId: folder?._id || null, folderName: folder?.name || folderName, isNewFolder: !folder, reason: String(m.reason || 'Related by topic.').slice(0, 200), source: 'ai' });
  }

  for (const r of Array.isArray(parsed.renames) ? parsed.renames : []) {
    const file = candidates[r?.index];
    const newStem = cleanFileStem(r?.name);
    if (!file || !newStem || !isVagueName(file.originalName)) continue;
    const newName = `${newStem}${extOf(file.originalName)}`;
    if (newName === file.originalName) continue;
    proposals.push({ type: 'rename', fileId: file._id, newName, reason: String(r.reason || 'Describes the contents better.').slice(0, 200), source: 'ai' });
  }
  return proposals;
}

async function suggestOrganization(userId, { folderId = null } = {}) {
  let scopeName = 'My Files';
  if (folderId) {
    const access = await authorizeFolder(folderId, userId, 'owner');
    if (access.status) throw Object.assign(new Error(access.message), { status: access.status });
    scopeName = access.folder.name;
  }

  const files = await File.find({ owner: userId, isTrashed: { $ne: true }, parentFolder: folderId || null })
    .select('originalName mimeType size createdAt updatedAt').sort({ createdAt: -1 }).limit(MAX_FILES).lean();
  const folders = await Folder.find({ owner: userId, isTrashed: { $ne: true }, parentFolder: folderId || null, isCourseFolder: { $ne: true } })
    .select('name').lean();

  const proposals = ruleProposals(files, folders);
  const health = await ollamaClient.health();
  const aiAvailable = Boolean(health.reachable && health.plannerModelAvailable);
  let aiError = '';
  if (aiAvailable) {
    try {
      const taken = new Set(proposals.filter(p => p.type === 'move').map(p => p.fileId.toString()));
      const renamed = new Set(proposals.filter(p => p.type === 'rename').map(p => p.fileId.toString()));
      // Rule-based groupings (e.g. Screenshots) belong to the rules; the model may not add unrelated files to them.
      const ruleFolders = new Set(proposals.filter(p => p.type === 'move' && p.isNewFolder).map(p => p.folderName.toLowerCase()));
      const extra = (await aiProposals(files, folders, taken))
        .filter(p => !(p.type === 'rename' && renamed.has(p.fileId.toString())))
        .filter(p => !(p.type === 'move' && ruleFolders.has(p.folderName.toLowerCase())));
      proposals.push(...extra);
    } catch (error) {
      aiError = error.message;
    }
  }

  const names = new Map(files.map(f => [f._id.toString(), f.originalName]));
  return {
    scope: { folderId: folderId || null, name: scopeName },
    fileCount: files.length,
    aiUsed: aiAvailable && !aiError,
    aiError: aiAvailable ? aiError : 'File Box AI is offline, so only rule-based suggestions are shown.',
    proposals: proposals.map((p, i) => ({
      id: `p${i + 1}`,
      ...p,
      fileId: p.fileId.toString(),
      folderId: p.folderId ? p.folderId.toString() : null,
      fileName: names.get(p.fileId.toString()),
      currentLocation: scopeName,
      scopeFolderId: folderId || null,
    })),
  };
}

/**
 * Apply reviewed proposals. Requires confirm === true. Each action is re-authorized (owner only),
 * destination folders must belong to the user, and names are re-validated.
 */
async function applyProposals(userId, { actions = [], confirm = false } = {}) {
  if (confirm !== true) throw Object.assign(new Error('Applying organization changes requires confirmation.'), { status: 400 });
  if (!Array.isArray(actions) || !actions.length) throw Object.assign(new Error('No changes selected.'), { status: 400 });
  if (actions.length > MAX_FILES) throw Object.assign(new Error('Too many changes at once.'), { status: 400 });

  const createdFolders = new Map();
  const results = [];
  for (const action of actions) {
    const result = { id: action.id, type: action.type, success: false };
    try {
      const access = await authorizeFile(action.fileId, userId, 'owner');
      if (access.status) throw new Error(access.message);
      const { file } = access;
      if (file.isTrashed) throw new Error('File is in Trash');

      if (action.type === 'move') {
        let target = null;
        if (action.folderId) {
          const folderAccess = await authorizeFolder(action.folderId, userId, 'owner');
          if (folderAccess.status || folderAccess.folder.isTrashed) throw new Error('Destination folder not found');
          target = folderAccess.folder;
        } else {
          const name = cleanFolderName(action.folderName);
          if (!name) throw new Error('Folder name is required');
          const parent = action.scopeFolderId || null;
          if (parent) {
            const parentAccess = await authorizeFolder(parent, userId, 'owner');
            if (parentAccess.status) throw new Error('Folder not found');
          }
          const key = `${parent}:${name.toLowerCase()}`;
          target = createdFolders.get(key)
            || await Folder.findOne({ owner: userId, parentFolder: parent, isTrashed: { $ne: true }, name })
            || await Folder.create({ name, owner: userId, parentFolder: parent });
          createdFolders.set(key, target);
        }
        if (String(file.parentFolder || '') === String(target._id)) throw new Error('Already in that folder');
        file.parentFolder = target._id;
        await file.save();
        await Activity.create({ user: userId, file: file._id, action: 'moved', details: `Organized into ${target.name}`, source: 'filebox' });
        Object.assign(result, { success: true, message: `Moved "${file.originalName}" to "${target.name}"`, file });
      } else if (action.type === 'rename') {
        const newStem = cleanFileStem(stem(action.newName || ''));
        if (!newStem) throw new Error('New name is required');
        const newName = `${newStem}${extOf(file.originalName)}`; // never change the file type
        const oldName = file.originalName;
        file.originalName = newName;
        await file.save();
        await Activity.create({ user: userId, file: file._id, action: 'renamed', details: `Renamed from ${oldName}`, source: 'filebox' });
        Object.assign(result, { success: true, message: `Renamed "${oldName}" to "${newName}"`, file });
      } else {
        throw new Error('Unknown change type');
      }
    } catch (error) {
      result.message = error.message;
    }
    results.push(result);
  }
  return { results, applied: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length };
}

module.exports = { suggestOrganization, applyProposals, isVagueName, ruleProposals };
