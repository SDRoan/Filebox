const mongoose = require('mongoose');

/**
 * A passage of a file's extracted text with its meaning vector (local embedding model), so File Box AI
 * can answer questions from the right part of the right file. Rebuilt when the file's text changes.
 * Access is never decided here: callers only search passages of files the user may read.
 */
const FileChunkSchema = new mongoose.Schema({
  file: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true, index: true },
  index: { type: Number, required: true },
  text: { type: String, required: true },
  embedding: { type: [Number], default: undefined },
  // The FileContent.extractedAt this passage was cut from; older passages are replaced.
  sourceExtractedAt: { type: Date },
  embeddingModel: { type: String, default: '' },
}, { timestamps: true });

FileChunkSchema.index({ file: 1, index: 1 }, { unique: true });

module.exports = mongoose.model('FileChunk', FileChunkSchema);
