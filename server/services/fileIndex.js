const File = require('../models/File');
const FileContent = require('../models/FileContent');
const FileChunk = require('../models/FileChunk');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { chunkText } = require('../utils/chunkText');

/**
 * Passages of every file's text, embedded with the local embedding model, so File Box AI can find the
 * part of a file that answers a question ("When is my electricity bill due?").
 */

const CHUNK_CHARS = 900;
const MAX_CHUNKS_PER_FILE = 200; // ~180,000 characters; the rest of very long files is not searched

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

/** True when the file's passages are missing or older than its text. */
async function needsIndex(fileContent) {
  if (!fileContent?.extractedText?.trim()) return false;
  const first = await FileChunk.findOne({ file: fileContent.file }).select('sourceExtractedAt').lean();
  if (!first) return true;
  return Boolean(fileContent.extractedAt && (!first.sourceExtractedAt || first.sourceExtractedAt < fileContent.extractedAt));
}

/** Cut a file's text into passages and embed them. Replaces older passages. */
async function indexFile(file, fileContent, { background = false } = {}) {
  const text = (fileContent?.extractedText || '').trim();
  if (!text) return 0;
  const passages = chunkText(text, CHUNK_CHARS).slice(0, MAX_CHUNKS_PER_FILE);
  const vectors = await ollamaClient.embed(passages.map(p => `search_document: ${file.originalName}. ${p}`), { background });
  await FileChunk.deleteMany({ file: file._id });
  await FileChunk.insertMany(passages.map((passage, index) => ({
    file: file._id,
    index,
    text: passage,
    embedding: vectors[index],
    sourceExtractedAt: fileContent.extractedAt || new Date(),
    embeddingModel: config.ollama.embeddingModel,
  })));
  return passages.length;
}

/** Index the given files now if they are missing passages (used before answering about them). */
async function ensureIndexed(fileIds, { limit = 10 } = {}) {
  const contents = await FileContent.find({ file: { $in: fileIds }, extractedText: { $nin: ['', null] } }).select('file extractedText extractedAt');
  let done = 0;
  for (const content of contents) {
    if (done >= limit) break;
    if (!(await needsIndex(content))) continue;
    const file = await File.findById(content.file).select('originalName');
    if (!file) continue;
    await indexFile(file, content);
    done += 1;
  }
  return done;
}

/**
 * The passages that best match a question, from the given files only (the caller decides access).
 * Returns [{ file, index, text, score }], best first, at most `perFile` from one file.
 */
async function searchPassages(fileIds, question, { k = 6, perFile = 3 } = {}) {
  if (!fileIds.length) return [];
  const [query] = await ollamaClient.embed([`search_query: ${question}`]);
  const chunks = await FileChunk.find({ file: { $in: fileIds }, embedding: { $exists: true } }).select('file index text embedding').lean();
  const scored = chunks
    .map(chunk => ({ file: chunk.file.toString(), index: chunk.index, text: chunk.text, score: cosine(query, chunk.embedding) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.index - b.index);
  const perFileCount = new Map();
  const picked = [];
  for (const passage of scored) {
    const n = perFileCount.get(passage.file) || 0;
    if (n >= perFile) continue;
    perFileCount.set(passage.file, n + 1);
    picked.push(passage);
    if (picked.length >= k) break;
  }
  return picked;
}

/** Remove passages of files that no longer exist. */
async function removeOrphans() {
  const fileIds = await FileChunk.distinct('file');
  if (!fileIds.length) return 0;
  const existing = new Set((await File.find({ _id: { $in: fileIds } }).select('_id').lean()).map(f => f._id.toString()));
  const orphans = fileIds.filter(id => !existing.has(id.toString()));
  if (orphans.length) await FileChunk.deleteMany({ file: { $in: orphans } });
  return orphans.length;
}

module.exports = { indexFile, ensureIndexed, needsIndex, searchPassages, removeOrphans };
