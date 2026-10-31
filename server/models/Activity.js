const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  file: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    default: null
  },
  folder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  action: {
    type: String,
    enum: [
      'uploaded',
      'created',
      'edited',
      'downloaded',
      'deleted',
      'restored',
      'renamed',
      'moved',
      'copied',
      'shared',
      'starred',
      'unstarred',
      'version_created',
      'version_restored',
      'commented',
      // Daily activity (Home "Your day"): opened a file to look at it, time spent in a file, asked File Box AI.
      'viewed',
      'focused',
      'asked'
    ],
    required: true
  },
  details: {
    type: String,
    default: ''
  },
  // 'filebox' when File Box AI or an approved File Box suggestion did it; 'user' otherwise.
  source: {
    type: String,
    enum: ['user', 'filebox'],
    default: 'user'
  },
  // 'focused': seconds spent with the file open and visible; endedAt is the last heartbeat.
  durationSeconds: {
    type: Number,
    default: 0
  },
  endedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

activitySchema.index({ file: 1, createdAt: -1 });
activitySchema.index({ folder: 1, createdAt: -1 });
activitySchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);
