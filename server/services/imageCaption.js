const fs = require('fs-extra');
const sharp = require('sharp');
const File = require('../models/File');
const config = require('../config/aiConfig');
const ollamaClient = require('./ollamaClient');

/**
 * Fun, social-media style captions for uploaded pictures, written by the local vision model.
 * The picture is shrunk first (the model does not need full resolution, and it is much faster),
 * and the caption is saved on the file so cards can show it without asking again.
 */

const MAX_SIDE = 768;
const MAX_TAGS = 4;
const CAPTIONABLE = /^image\/(png|jpe?g|webp|gif|avif|tiff|bmp)$/i;
const inFlight = new Set();

const SYSTEM = `You write captions for photos people post on social media.
First, in "seen", list in a few words only what is clearly visible in the picture (colors, objects, mood). Do not add things you cannot see.
Then write "caption": one short, witty caption built on something from "seen", the way a funny friend would post it.
Rules for the caption:
- At most about 20 words, with one or two fitting emoji.
- Playful and clever, not generic: avoid plain descriptions like "nature is so pretty". A pun, a joke or a relatable feeling is great.
- Never make fun of how a person looks, and never guess who someone is.
Finally give 2 to 4 short hashtags about the picture (letters and numbers only, no spaces).
Examples of the tone:
- seen: "a cat asleep on a laptop keyboard" -> caption: "My coworker refuses to let me answer emails today 🐈💻"
- seen: "a stack of pancakes with syrup" -> caption: "Stack goals achieved. Diet starts… eventually 🥞"`;

const FORMAT = {
  type: 'object',
  properties: {
    seen: { type: 'string' },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['seen', 'caption', 'hashtags'],
};

const canCaption = (file) => CAPTIONABLE.test(String(file?.mimeType || ''));

async function shrink(filePath) {
  return sharp(await fs.readFile(filePath), { animated: false })
    .rotate()
    .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82 })
    .toBuffer();
}

const cleanTag = (tag) => String(tag || '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 30);

function parseCaption(text) {
  const data = JSON.parse(text);
  const caption = String(data.caption || '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  if (!caption) throw new Error('The model wrote an empty caption.');
  const hashtags = [...new Set((data.hashtags || []).map(cleanTag).filter(Boolean))].slice(0, MAX_TAGS);
  return { caption: caption.slice(0, 280), hashtags };
}

/**
 * Write a caption for one picture and save it. `again` asks for a different one (a new seed,
 * with the previous caption to avoid). Returns the saved caption.
 */
async function writeCaption(fileId, { again = false } = {}) {
  const file = await File.findById(fileId);
  if (!file || !canCaption(file)) return null;
  const previous = file.aiCaption?.text;
  const attempt = again ? (file.aiCaption?.attempt || 0) + 1 : 0;
  await File.updateOne({ _id: file._id }, { $set: { 'aiCaption.status': 'writing', 'aiCaption.error': '' } });
  try {
    const image = (await shrink(file.path)).toString('base64');
    const { text } = await ollamaClient.generate({
      task: 'caption',
      model: config.ollama.visionModel,
      keepAlive: '30s', // a large model, only needed for this picture
      seed: config.ollama.seed + attempt,
      system: SYSTEM,
      content: again && previous
        ? `Write a new caption for this picture, different from this one: "${previous}"`
        : 'Write a caption for this picture.',
      images: [image],
      format: FORMAT,
    });
    const { caption, hashtags } = parseCaption(text);
    const aiCaption = { text: caption, hashtags, status: 'done', error: '', model: config.ollama.visionModel, attempt, at: new Date() };
    await File.updateOne({ _id: file._id }, { $set: { aiCaption } });
    console.log(`[Caption] ${file.originalName}: ${caption}`);
    return aiCaption;
  } catch (error) {
    console.error(`[Caption] Could not caption ${file.originalName}:`, error.message);
    const message = /not found|pull/i.test(error.message)
      ? `Captions need the local model ${config.ollama.visionModel}.`
      : 'File Box AI could not write a caption this time.';
    await File.updateOne({ _id: file._id }, { $set: { 'aiCaption.status': 'failed', 'aiCaption.error': message } });
    throw Object.assign(new Error(message), { status: 503 });
  }
}

/** Start captioning in the background (after an upload, or when asked for another one). */
function captionInBackground(file, options = {}) {
  if (!canCaption(file) || !config.ollama.enabled) return false;
  const id = String(file._id);
  if (inFlight.has(id)) return true;
  inFlight.add(id);
  File.updateOne({ _id: file._id }, { $set: { 'aiCaption.status': 'writing', 'aiCaption.error': '' } })
    .then(() => writeCaption(id, options))
    .catch(() => {})
    .finally(() => inFlight.delete(id));
  return true;
}

module.exports = { canCaption, writeCaption, captionInBackground, parseCaption };
