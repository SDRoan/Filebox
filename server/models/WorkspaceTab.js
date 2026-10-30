const mongoose = require('mongoose');

/**
 * Boards: one tab of a person's own workspace (Work, School, Bills, …). A tab holds blocks that point at
 * real File Box files and folders by id, plus notes and text. It never holds copies of files, and adding
 * or removing a block never moves or deletes anything in My Files. Validated in services/workspaceBoards.js.
 */
const workspaceTabSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tabId: { type: String, required: true, match: /^[a-z0-9]{10}$/ },
  name: { type: String, required: true, maxlength: 40 },
  icon: { type: String, default: '' },
  color: { type: String, default: '' },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  // Bumped on every save; a save carrying an older number is refused, so one device cannot silently
  // overwrite changes made on another.
  rev: { type: Number, default: 0 },
  // File, folder, sticky note and text blocks with their places on the free canvas (pixels).
  blocks: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Zones drawn on this tab's board (same shape as My Files > Board zones).
  zones: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // 2 = free canvas in pixels. Older tabs (a 12-column grid) are converted when read (utils/boardLayout.js).
  layoutVersion: { type: Number },
  // Stored size of the tab in bytes, kept so the per-person total can be checked without loading blocks.
  bytes: { type: Number, default: 0 },
}, { timestamps: true });

workspaceTabSchema.index({ user: 1, tabId: 1 }, { unique: true });

module.exports = mongoose.model('WorkspaceTab', workspaceTabSchema);
