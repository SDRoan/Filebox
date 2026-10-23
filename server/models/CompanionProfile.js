const mongoose = require('mongoose');

// File Box AI as a companion: what the person calls it, how it talks, how often it speaks up, and the
// things they asked it to remember. One per person.
const companionProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  name: { type: String, default: '', maxlength: 30 },
  tone: { type: String, enum: ['friendly', 'concise', 'professional', 'playful'], default: 'friendly' },
  // quiet: only answers; balanced: a dot when it has something; chatty: also a short note once a day.
  proactivity: { type: String, enum: ['quiet', 'balanced', 'chatty'], default: 'balanced' },
  memoryOn: { type: Boolean, default: true },
  memories: [{
    text: { type: String, required: true, maxlength: 300 },
    createdAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

module.exports = mongoose.model('CompanionProfile', companionProfileSchema);
