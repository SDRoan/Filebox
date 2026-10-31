const mongoose = require('mongoose');

const FileContentSchema = new mongoose.Schema({
  file: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: true,
    unique: true
  },
  extractedText: {
    type: String,
    default: ''
  },
  embedding: {
    type: [Number], // Vector embedding for semantic search
    default: []
  },
  extractedAt: {
    type: Date,
    default: Date.now
  },
  extractionMethod: {
    type: String,
    default: ''
  },
  editorHtml: {
    type: String,
    default: ''
  },
  editorUpdatedAt: {
    type: Date
  },
  extractionStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'not_supported'],
    default: 'pending'
  },
  summary: {
    type: String,
    default: ''
  },
  summaryStatus: {
    type: String,
    enum: ['not_started', 'pending', 'completed', 'failed'],
    default: 'not_started'
  },
  summaryError: {
    type: String,
    default: ''
  },
  summaryProvider: {
    type: String,
    default: ''
  },
  summaryGeneratedAt: {
    type: Date
  },
  summaryModel: {
    type: String,
    default: ''
  },
  // What the file is, written once by the local model (services/fileProfiler.js) so File Box AI can
  // find "my resume" even when the name and text never say "resume".
  aiType: {
    type: String,
    default: ''
  },
  aiDescription: {
    type: String,
    default: ''
  },
  aiProfiledAt: {
    type: Date
  },
  aiProfileModel: {
    type: String,
    default: ''
  },
  // Broad category (homework, transcript, bill, certificate, ...) and key facts read from the text,
  // e.g. [{ label: 'Amount due', value: '$84.20' }]. aiProfileVersion lets File Box re-read older notes.
  aiCategory: {
    type: String,
    default: ''
  },
  aiFacts: {
    type: [{ label: String, value: String, _id: false }],
    default: undefined
  },
  aiProfileVersion: {
    type: Number,
    default: 0
  },
  // Meaning vector from the local embedding model, built from the profile ('profile') or, until a profile
  // exists, from the name and opening text ('text').
  aiEmbedding: {
    type: [Number],
    default: undefined
  },
  aiEmbeddingSource: {
    type: String,
    default: ''
  },
  // Up to 5 subjects the file is about, written with the profile ("Operating Systems", "Semaphores").
  // Left unset (not []) until a profile has looked, so older files can be picked up one at a time.
  topics: {
    type: [String],
    default: undefined
  },
  // What kind of document this is for Advanced Search (services/fileClassifier.js): one category and one
  // document type, worked out from rules and aiCategory. Metadata only; it never moves the file.
  primaryCategory: {
    type: String,
    default: ''
  },
  documentType: {
    type: String,
    default: ''
  },
  classificationSource: {
    type: String,
    enum: ['', 'rules', 'profile', 'default'],
    default: ''
  },
  classifiedAt: {
    type: Date
  },
  classificationVersion: {
    type: Number
  },
  // A person's correction. Always wins over the automatic fields above, and only the correction route
  // writes it: profiling, classifying and re-reading the file never change it.
  userClassification: {
    type: new mongoose.Schema({
      primaryCategory: String,
      documentType: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date
    }, { _id: false }),
    default: undefined
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('FileContent', FileContentSchema);
