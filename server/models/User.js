const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const appConfig = require('../config/appConfig');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  // Appearance: the accent color File Box is shown in (Settings > Appearance). null = File Box green.
  accentColor: {
    type: String,
    default: null,
    match: /^#[0-9a-fA-F]{6}$/
  },
  storageUsed: {
    type: Number,
    default: 0
  },
  storageLimit: {
    type: Number,
    default: appConfig.storage.defaultLimit
  },
  avatar: {
    type: String,
    default: null
  },
  savedPosts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialPost'
  }],
  bio: {
    type: String,
    maxlength: 200,
    default: ''
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'security_officer', 'compliance_officer'],
    default: 'user'
  },
  organization: {
    type: String,
    default: ''
  },
  department: {
    type: String,
    default: ''
  },
  securityClearance: {
    type: String,
    enum: ['None', 'Public', 'Internal', 'Confidential', 'Top Secret'],
    default: 'Internal'
  },
  lastLogin: {
    type: Date,
    default: null
  },
  lastLoginIp: {
    type: String,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  referralCount: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Registration hashes the password before email verification, so a value may already be a bcrypt hash.
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

userSchema.pre('save', async function(next) {
  if (!this.isModified('password') || BCRYPT_HASH.test(this.password)) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);

