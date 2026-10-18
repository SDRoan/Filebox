const mongoose = require('mongoose');

/**
 * 👍/👎 on a File Box AI answer, with an optional correction ("the right file was X").
 * Corrections are used for the same person's later, similar requests (services/aiFeedback.js) and can be
 * exported as test cases (scripts/exportAiFeedback.js). Stays on this machine like everything else.
 */
const AIFeedbackSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  question: { type: String, required: true, maxlength: 2000 },
  answer: { type: String, default: '', maxlength: 4000 },
  intent: { type: String, default: '' },
  action: { type: String, default: '' },
  // What the request was looking for, and its meaning vector (to recognise similar requests later).
  phrase: { type: String, default: '' },
  phraseEmbedding: { type: [Number], default: undefined },
  rating: { type: String, enum: ['up', 'down'], required: true },
  shownFiles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'File' }],
  correctFile: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
  note: { type: String, default: '', maxlength: 1000 },
}, { timestamps: true });

module.exports = mongoose.model('AIFeedback', AIFeedbackSchema);
