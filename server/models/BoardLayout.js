const mongoose = require('mongoose');

// My Files > Board: where a person placed files and folders, and the zones they drew, for one folder.
// Only the layout is stored here; files stay in their real folders.
const boardLayoutSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Which folder the board belongs to: 'root', a folder id, or 'team-<id>' / 'team-<id>-<folder id>'.
  folderKey: { type: String, required: true, match: /^[a-z0-9-]{1,80}$/ },
  items: { type: mongoose.Schema.Types.Mixed, default: {} },
  zones: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

boardLayoutSchema.index({ user: 1, folderKey: 1 }, { unique: true });

module.exports = mongoose.model('BoardLayout', boardLayoutSchema);
