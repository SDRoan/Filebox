const mongoose = require('mongoose');

/**
 * File Box AI's written summary of one person's day in File Box (Home "Your day"). Rewritten when the
 * day's activity changes (factsHash). Local only, like everything else.
 */
const DailySummarySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD in the person's time zone
  factsHash: { type: String, required: true },
  summary: { type: String, default: '' },
  highlights: { type: [String], default: [] },
  suggestions: { type: [String], default: [] },
  // true when written without the model (Ollama off): plain sentences from the facts.
  basic: { type: Boolean, default: false },
  model: { type: String, default: '' },
}, { timestamps: true });

DailySummarySchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailySummary', DailySummarySchema);
