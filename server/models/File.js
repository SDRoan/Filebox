const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  originalName: {
    type: String,
    required: true
  },
  path: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: true
  },
  mimeType: {
    type: String,
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  parentFolder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null
  },
  isFolder: {
    type: Boolean,
    default: false
  },
  isStarred: {
    type: Boolean,
    default: false
  },
  isTrashed: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },
  recoveryPeriodDays: {
    type: Number,
    default: 30 // Default 30 days recovery period
  },
  sharedWith: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    permission: {
      type: String,
      enum: ['view', 'edit'],
      default: 'view'
    },
    password: {
      type: String,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    }
  }],
  // Set on copies made by Folder Sync: where the file came from and the version that was copied.
  syncedFrom: {
    path: { type: String, default: null },
    mtimeMs: { type: Number, default: null },
    size: { type: Number, default: null },
  },
  // A fun caption for a picture, written by the local vision model after upload.
  aiCaption: {
    text: { type: String, default: '' },
    hashtags: [{ type: String }],
    status: { type: String, enum: ['', 'writing', 'done', 'failed'], default: '' },
    error: { type: String, default: '' },
    model: { type: String, default: '' },
    attempt: { type: Number, default: 0 },
    at: { type: Date, default: null },
  },
  dataClassification: {
    type: String,
    enum: ['Public', 'Internal', 'Confidential', 'Top Secret'],
    default: 'Internal'
  },
  encryptionEnabled: {
    type: Boolean,
    default: true
  },
  watermarkEnabled: {
    type: Boolean,
    default: false
  },
  accessLog: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    action: {
      type: String,
      enum: ['view', 'download', 'edit', 'delete']
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    ipAddress: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

fileSchema.index({ owner: 1, parentFolder: 1 });
fileSchema.index({ owner: 1, isTrashed: 1 });

module.exports = mongoose.model('File', fileSchema);



