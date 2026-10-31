const mongoose = require('mongoose');
const AIFeedback = require('../models/AIFeedback');
const ollamaClient = require('./ollamaClient');

/**
 * Learning from a person's corrections. When they said "the right file was X" for a request, a later
 * request with the same meaning includes X, and leaves out the file they marked wrong for it.
 * Corrections only ever apply to the person who made them.
 */

const SIMILAR = 0.86; // how close in meaning a new request must be to a corrected one

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

async function embedPhrase(phrase) {
  try {
    const [vector] = await ollamaClient.embed([`search_query: ${phrase}`]);
    return vector;
  } catch (error) {
    return undefined;
  }
}

/** Save 👍/👎 (and an optional correct file, already checked for access by the caller). */
async function recordFeedback(userId, { question, answer, intent, action, phrase, rating, shownFiles, correctFile, note }) {
  const usable = (ids) => (ids || []).filter(id => mongoose.isValidObjectId(id)).slice(0, 20);
  const cleanPhrase = String(phrase || question || '').slice(0, 300);
  return AIFeedback.create({
    user: userId,
    question: String(question || '').slice(0, 2000),
    answer: String(answer || '').slice(0, 4000),
    intent: String(intent || '').slice(0, 40),
    action: String(action || '').slice(0, 40),
    phrase: cleanPhrase,
    phraseEmbedding: correctFile || rating === 'down' ? await embedPhrase(cleanPhrase) : undefined,
    rating,
    shownFiles: usable(shownFiles),
    correctFile: correctFile || null,
    note: String(note || '').slice(0, 1000),
  });
}

/**
 * Corrections that apply to this request: { include: [fileId], exclude: [fileId] } (strings).
 * Never throws; without the embedding model there are simply no corrections.
 */
async function correctionsFor(userId, phrase) {
  const past = await AIFeedback.find({ user: userId, rating: 'down', correctFile: { $ne: null }, phraseEmbedding: { $exists: true } })
    .sort({ createdAt: -1 }).limit(200).lean();
  if (!past.length || !phrase) return { include: [], exclude: [] };
  const vector = await embedPhrase(phrase);
  if (!vector) return { include: [], exclude: [] };
  const include = new Set();
  const exclude = new Set();
  for (const feedback of past) {
    if (cosine(vector, feedback.phraseEmbedding) < SIMILAR) continue;
    include.add(feedback.correctFile.toString());
    (feedback.shownFiles || []).forEach(id => { if (!id.equals(feedback.correctFile)) exclude.add(id.toString()); });
  }
  include.forEach(id => exclude.delete(id));
  return { include: [...include], exclude: [...exclude] };
}

module.exports = { recordFeedback, correctionsFor };
