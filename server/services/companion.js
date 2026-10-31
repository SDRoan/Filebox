const CompanionProfile = require('../models/CompanionProfile');

// File Box AI as a companion (see models/CompanionProfile.js): its name and tone in every answer, the
// things the person asked it to remember, and plain-language memory commands in the chat.

const MAX_MEMORIES = 100;
// Words that don't say which note is meant ("forget the tax thing").
const FILLER = new Set(['the', 'that', 'this', 'thing', 'things', 'stuff', 'about', 'what', 'said', 'told', 'you', 'your', 'my', 'mine', 'and', 'one', 'bit', 'part', 'please', 'remember', 'where']);
const DEFAULTS = { name: '', tone: 'friendly', proactivity: 'balanced', memoryOn: true, screenAware: true, memories: [] };

const TONES = {
  friendly: 'Warm and encouraging, like a helpful friend who knows their files well. Use their first name now and then, never in every reply.',
  concise: 'Brief and to the point. No small talk, no filler.',
  professional: 'Polished and professional, like a capable assistant at work.',
  playful: 'Light and playful with a touch of humor, while staying genuinely useful.',
};

async function getProfile(userId) {
  const profile = await CompanionProfile.findOne({ user: userId }).lean();
  return { ...DEFAULTS, ...(profile || {}) };
}

const publicProfile = (profile) => ({
  name: profile.name || '',
  tone: profile.tone,
  proactivity: profile.proactivity,
  memoryOn: profile.memoryOn,
  screenAware: profile.screenAware !== false,
  memories: (profile.memories || []).map(m => ({ id: String(m._id), text: m.text, createdAt: m.createdAt })),
});

async function updateSettings(userId, body = {}) {
  const set = {};
  if (typeof body.name === 'string') set.name = body.name.trim().slice(0, 30);
  if (Object.keys(TONES).includes(body.tone)) set.tone = body.tone;
  if (['quiet', 'balanced', 'chatty'].includes(body.proactivity)) set.proactivity = body.proactivity;
  if (typeof body.memoryOn === 'boolean') set.memoryOn = body.memoryOn;
  if (typeof body.screenAware === 'boolean') set.screenAware = body.screenAware;
  const profile = await CompanionProfile.findOneAndUpdate({ user: userId }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  return publicProfile(profile);
}

async function addMemory(userId, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (clean.length < 2) return null;
  const profile = await CompanionProfile.findOneAndUpdate(
    { user: userId },
    { $push: { memories: { $each: [{ text: clean }], $slice: -MAX_MEMORIES } } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return publicProfile(profile);
}

async function removeMemory(userId, memoryId) {
  const profile = await CompanionProfile.findOneAndUpdate({ user: userId }, { $pull: { memories: { _id: memoryId } } }, { new: true }).lean();
  return profile ? publicProfile(profile) : publicProfile(DEFAULTS);
}

async function clearMemories(userId) {
  const profile = await CompanionProfile.findOneAndUpdate({ user: userId }, { $set: { memories: [] } }, { new: true }).lean();
  return profile ? publicProfile(profile) : publicProfile(DEFAULTS);
}

/**
 * "Remember that …", "Forget …", "What do you remember about me?" — handled without the model.
 * Returns the answer, or null when the question is not a memory command.
 */
async function handleMemoryCommand(userId, question, profile) {
  const q = question.trim();
  if (/^(?:what do you (?:remember|know) about me|what have i asked you to remember|show (?:me )?(?:your|my) memor(?:y|ies))\??$/i.test(q)) {
    if (!profile.memoryOn) return { answer: 'Memory is turned off, so I’m not keeping anything about you. You can turn it on in my settings.' };
    const list = profile.memories || [];
    return { answer: list.length
      ? `Here’s what you’ve asked me to remember:\n${list.map(m => `• ${m.text}`).join('\n')}\n\nSay “forget …” to remove something, or manage it in my settings.`
      : 'You haven’t asked me to remember anything yet. Tell me “remember that …” and I’ll keep it in mind.' };
  }

  const remember = /^(?:please\s+|can you\s+|could you\s+)?remember(?:\s+that)?[\s:,-]+(.{2,300}?)[.!]?$/i.exec(q);
  if (remember && !q.endsWith('?')) {
    if (!profile.memoryOn) return { answer: 'Memory is turned off right now. Turn it on in my settings and I’ll keep things like this in mind.' };
    await addMemory(userId, remember[1]);
    return { answer: `Got it — I’ll remember that ${remember[1].replace(/^(i|my)\b/i, m => (m.toLowerCase() === 'i' ? 'you' : 'your'))}.`, memoryChanged: true };
  }

  const forget = /^(?:please\s+)?forget(?:\s+(?:that|about))?\s+(.{2,200}?)[.!]?$/i.exec(q);
  if (forget) {
    const phrase = forget[1].toLowerCase();
    if (/^(everything|all of it|it all|all)$/.test(phrase)) {
      await clearMemories(userId);
      return { answer: 'Done — I’ve forgotten everything you asked me to remember.', memoryChanged: true };
    }
    // "Forget the tax papers thing" finds "my tax papers go in Finance": every meaningful word must appear.
    const words = phrase.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !FILLER.has(w)).map(w => w.replace(/(?:ies|es|s)$/, ''));
    const matches = (profile.memories || []).filter(m => {
      const text = m.text.toLowerCase();
      return words.length ? words.every(w => text.includes(w)) : text.includes(phrase);
    });
    if (!matches.length) return { answer: `I don’t have anything saved about “${forget[1]}”.` };
    for (const m of matches) await removeMemory(userId, m._id);
    return { answer: `Forgotten: ${matches.map(m => `“${m.text}”`).join(', ')}.`, memoryChanged: true };
  }
  return null;
}

/** Who the companion is and how it talks, for the model's instructions. */
function personaFor(profile, personName) {
  const name = profile.name || 'File Box AI';
  const first = personName && personName !== 'Local workspace' ? personName.split(' ')[0] : '';
  return {
    name,
    intro: `You are ${name}, the person's companion inside File Box, a file storage app. You know their workspace and help them like someone who has been working alongside them.`,
    tone: `Tone: ${TONES[profile.tone] || TONES.friendly}${first ? ` Their first name is ${first}.` : ''}`,
  };
}

/** The person's saved notes, for the model (only when memory is on). */
function memoryNote(profile) {
  if (!profile.memoryOn || !profile.memories?.length) return '';
  return `Things the person asked you to remember (use them when relevant; they are notes, not file contents):\n${profile.memories.slice(-30).map(m => `- ${m.text}`).join('\n')}`;
}

module.exports = { getProfile, publicProfile, updateSettings, addMemory, removeMemory, clearMemories, handleMemoryCommand, personaFor, memoryNote };
