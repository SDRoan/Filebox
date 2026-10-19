const crypto = require('crypto');
const Activity = require('../models/Activity');
const File = require('../models/File');
const Folder = require('../models/Folder');
const FileContent = require('../models/FileContent');
const DailySummary = require('../models/DailySummary');
const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');

/**
 * "Your day" on Home: what the person did in File Box on a given day, and File Box AI's summary of it.
 *
 * Facts come from the activity log only (uploads, views, edits, time spent in files, shares, questions
 * asked in File Box AI, changes File Box made for them). The summary is written by the local model from
 * those facts and nothing else; without Ollama, plain sentences are built from the same facts.
 */

const ACTION_WORDS = {
  uploaded: 'uploaded', created: 'created', edited: 'edited', downloaded: 'downloaded', deleted: 'moved to Trash',
  restored: 'restored', renamed: 'renamed', moved: 'moved', copied: 'copied', shared: 'shared', starred: 'starred',
  unstarred: 'unstarred', version_created: 'saved a new version of', version_restored: 'restored a version of',
  commented: 'commented on', viewed: 'opened', focused: 'worked in', asked: 'asked File Box AI',
};

const pad = (n) => String(n).padStart(2, '0');

/** The [start, end) of a calendar day in the person's time zone (tzOffset = minutes behind UTC, as in JS). */
function dayRange(date, tzOffset = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) + tzOffset * 60000);
  return { start, end: new Date(start.getTime() + 24 * 3600000) };
}

function localDate(when, tzOffset = 0) {
  const shifted = new Date(when.getTime() - tzOffset * 60000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const localHour = (when, tzOffset = 0) => new Date(when.getTime() - tzOffset * 60000).getUTCHours();

/** Everything the person did in File Box on that day, organised for Home and for the summary. */
async function dayFacts(userId, date, tzOffset = 0) {
  const { start, end } = dayRange(date, tzOffset);
  const entries = await Activity.find({ user: userId, createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }).lean();

  const fileIds = [...new Set(entries.filter(e => e.file).map(e => e.file.toString()))];
  const folderIds = [...new Set(entries.filter(e => e.folder).map(e => e.folder.toString()))];
  const [files, folders, profiles] = await Promise.all([
    File.find({ _id: { $in: fileIds } }).select('originalName mimeType isTrashed parentFolder owner').lean(),
    Folder.find({ _id: { $in: folderIds } }).select('name').lean(),
    FileContent.find({ file: { $in: fileIds } }).select('file aiType aiDescription').lean(),
  ]);
  const fileById = new Map(files.map(f => [f._id.toString(), f]));
  const folderById = new Map(folders.map(f => [f._id.toString(), f]));
  const profileById = new Map(profiles.map(p => [p.file.toString(), p]));

  const byFile = new Map();
  const questions = [];
  const folderActions = [];
  const timeline = new Map();
  let fileboxActions = 0;
  const totals = { activeMinutes: 0, filesWorkedOn: 0, uploaded: 0, edited: 0, viewed: 0, downloaded: 0, shared: 0, organized: 0, questions: 0 };

  // Per hour: each kind of action once, with the files it touched ("uploaded 10 files: a, b and 8 more").
  const addToTimeline = (when, verb, name = '') => {
    const hour = localHour(when, tzOffset);
    if (!timeline.has(hour)) timeline.set(hour, new Map());
    const slot = timeline.get(hour);
    if (!slot.has(verb)) slot.set(verb, []);
    if (name && !slot.get(verb).includes(name)) slot.get(verb).push(name);
  };
  const formatSlot = (slot) => [...slot.entries()].map(([verb, names]) => {
    if (!names.length) return verb;
    if (names.length === 1) return `${verb} ${names[0]}`;
    if (names.length === 2) return `${verb} ${names[0]} and ${names[1]}`;
    return `${verb} ${names.length} files: ${names[0]}, ${names[1]} and ${names.length - 2} more`;
  });

  for (const entry of entries) {
    if (entry.source === 'filebox') fileboxActions += 1;
    if (entry.action === 'asked') {
      questions.push({ question: entry.details, at: entry.createdAt });
      totals.questions += 1;
      addToTimeline(entry.createdAt, `asked File Box AI "${entry.details.slice(0, 80)}"`);
      continue;
    }
    if (entry.file) {
      const id = entry.file.toString();
      const file = fileById.get(id);
      const name = file?.originalName || entry.details || 'a file';
      if (!byFile.has(id)) {
        const profile = profileById.get(id);
        byFile.set(id, {
          fileId: id,
          name,
          kind: profile?.aiType || '',
          about: profile?.aiDescription || '',
          exists: Boolean(file && !file.isTrashed),
          parentFolder: file?.parentFolder ? file.parentFolder.toString() : null,
          seconds: 0,
          actions: {},
          firstAt: entry.createdAt,
          lastAt: entry.endedAt || entry.createdAt,
          byFileBox: 0,
        });
      }
      const item = byFile.get(id);
      item.actions[entry.action] = (item.actions[entry.action] || 0) + 1;
      if (entry.action === 'focused') item.seconds += entry.durationSeconds || 0;
      if (entry.source === 'filebox') item.byFileBox += 1;
      const last = entry.endedAt || entry.createdAt;
      if (last > item.lastAt) item.lastAt = last;
      if (entry.action !== 'focused') {
        addToTimeline(entry.createdAt, `${entry.source === 'filebox' ? 'File Box ' : ''}${ACTION_WORDS[entry.action] || entry.action}`, name);
      } else if ((entry.durationSeconds || 0) >= 60) {
        addToTimeline(entry.createdAt, `worked in ${name} for ${Math.round(entry.durationSeconds / 60)} min`);
      }
      if (entry.action === 'uploaded') totals.uploaded += 1;
      if (['edited', 'version_created'].includes(entry.action)) totals.edited += 1;
      if (entry.action === 'viewed') totals.viewed += 1;
      if (entry.action === 'downloaded') totals.downloaded += 1;
      if (entry.action === 'shared') totals.shared += 1;
      if (['moved', 'renamed'].includes(entry.action)) totals.organized += 1;
    } else if (entry.folder) {
      const name = folderById.get(entry.folder.toString())?.name || entry.details.replace(/^Folder:\s*/, '') || 'a folder';
      folderActions.push({ action: entry.action, name, at: entry.createdAt });
      addToTimeline(entry.createdAt, `${ACTION_WORDS[entry.action] || entry.action} folder`, name);
    }
  }

  const worked = [...byFile.values()]
    .map(item => ({ ...item, minutes: Math.round(item.seconds / 60) }))
    .sort((a, b) => b.seconds - a.seconds || Object.values(b.actions).reduce((x, y) => x + y, 0) - Object.values(a.actions).reduce((x, y) => x + y, 0) || a.name.localeCompare(b.name));
  totals.activeMinutes = Math.round(worked.reduce((sum, item) => sum + item.seconds, 0) / 60);
  totals.filesWorkedOn = worked.length;

  return {
    date,
    totals,
    files: worked,
    questions,
    folders: folderActions,
    fileboxActions,
    timeline: [...timeline.entries()].sort((a, b) => a[0] - b[0]).map(([hour, slot]) => ({ hour, items: formatSlot(slot).slice(0, 12) })),
    empty: entries.length === 0,
  };
}

/** Days with activity in the last `days` days (for the day picker): [{ date, count }]. */
async function recentDays(userId, tzOffset = 0, days = 14) {
  const since = new Date(Date.now() - days * 24 * 3600000);
  const entries = await Activity.find({ user: userId, createdAt: { $gte: since } }).select('createdAt').lean();
  const counts = new Map();
  entries.forEach(e => {
    const date = localDate(e.createdAt, tzOffset);
    counts.set(date, (counts.get(date) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, count]) => ({ date, count }));
}

const describeActions = (actions) => Object.entries(actions)
  .filter(([action]) => action !== 'focused')
  .map(([action, n]) => `${ACTION_WORDS[action] || action}${n > 1 ? ` ${n}x` : ''}`)
  .join(', ');

/** The facts as compact lines for the model (only what happened; no file contents beyond File Box's notes). */
function factsForModel(facts) {
  const lines = [
    `Day: ${facts.date}`,
    `Totals: ${facts.totals.activeMinutes} minutes with files open, ${facts.totals.filesWorkedOn} files, ${facts.totals.uploaded} uploaded, ${facts.totals.edited} edited, ${facts.totals.viewed} opened, ${facts.totals.downloaded} downloaded, ${facts.totals.shared} shared, ${facts.totals.questions} questions to File Box AI.`,
    'Files:',
    ...facts.files.slice(0, 12).map(f => `- ${f.name}${f.kind ? ` (${f.kind})` : ''}: ${f.minutes ? `${f.minutes} min open; ` : ''}${describeActions(f.actions) || 'opened'}${f.about ? `. About: ${f.about}` : ''}`),
  ];
  if (facts.folders.length) lines.push('Folders:', ...facts.folders.slice(0, 8).map(f => `- ${ACTION_WORDS[f.action] || f.action} ${f.name}`));
  if (facts.questions.length) lines.push('Questions asked:', ...facts.questions.slice(0, 10).map(q => `- ${q.question}`));
  if (facts.fileboxActions) lines.push(`Changes File Box made on request: ${facts.fileboxActions}`);
  lines.push('Timeline:', ...facts.timeline.map(t => `- ${pad(t.hour)}:00 ${t.items.join('; ')}`));
  return lines.join('\n');
}

/** Plain sentences from the facts, for when Ollama is not running. */
function basicSummary(facts) {
  const t = facts.totals;
  const top = facts.files[0];
  const parts = [];
  parts.push(`You worked with ${t.filesWorkedOn} file${t.filesWorkedOn === 1 ? '' : 's'}${t.activeMinutes ? ` for about ${t.activeMinutes} minute${t.activeMinutes === 1 ? '' : 's'}` : ''}.`);
  if (top) parts.push(`Most of your time went to ${top.name}${top.minutes ? ` (${top.minutes} min)` : ''}.`);
  const did = [t.uploaded && `uploaded ${t.uploaded}`, t.edited && `edited ${t.edited}`, t.shared && `shared ${t.shared}`, t.downloaded && `downloaded ${t.downloaded}`].filter(Boolean);
  if (did.length) parts.push(`You ${did.join(', ')} file${did.length ? 's' : ''}.`);
  if (t.questions) parts.push(`You asked File Box AI ${t.questions} question${t.questions === 1 ? '' : 's'}.`);
  return {
    summary: parts.join(' '),
    highlights: facts.files.slice(0, 4).map(f => `${f.name}: ${describeActions(f.actions) || 'opened'}${f.minutes ? ` · ${f.minutes} min` : ''}`),
    suggestions: [],
  };
}

const hashFacts = (facts) => crypto.createHash('sha256').update(factsForModel(facts)).digest('hex');

/** The cached summary for the day if it still matches the day's activity, else null. */
async function cachedSummary(userId, facts) {
  const saved = await DailySummary.findOne({ user: userId, date: facts.date }).lean();
  if (!saved || saved.factsHash !== hashFacts(facts)) return null;
  return { summary: saved.summary, highlights: saved.highlights, suggestions: saved.suggestions, basic: saved.basic, generatedAt: saved.updatedAt };
}

// Summaries being written right now, so Home can show "writing…" and nothing is written twice.
const inProgress = new Map(); // `${userId}:${date}` -> Promise

const isWriting = (userId, date) => inProgress.has(`${userId}:${date}`);

/** Start writing the day's summary in the background (Home checks back for it). Returns the promise. */
function startSummary(userId, facts, options = {}) {
  const key = `${userId}:${facts.date}`;
  if (!inProgress.has(key)) {
    const job = writeSummary(userId, facts, options)
      .catch((error) => console.error('[Daily summary] Could not write summary:', error.message))
      .finally(() => inProgress.delete(key));
    inProgress.set(key, job);
  }
  return inProgress.get(key);
}

/** Write (or reuse) File Box AI's summary of the day. `force` writes a new one even if it is current. */
async function writeSummary(userId, facts, { onToken, force = false } = {}) {
  if (facts.empty) return { summary: '', highlights: [], suggestions: [], basic: true };
  const cached = force ? null : await cachedSummary(userId, facts);
  if (cached && !(cached.basic && (await ollamaClient.health()).reachable)) return cached;

  let result;
  let basic = false;
  const health = await ollamaClient.health();
  if (health.reachable) {
    try {
      const raw = await ollamaClient.chat({
        task: 'summarize',
        model: config.ollama.assistantModel,
        onToken,
        system: `You write a person's daily work summary for File Box, their file storage app, from a log of what they did in File Box that day.
Return JSON with:
- "summary": 2-4 sentences in the second person ("You spent most of the day on ..."), describing what they worked on and accomplished, naming files and what kind of files they are. Mention time only when the log gives minutes.
- "highlights": up to 5 short bullet points of the most important things they did, most important first.
- "suggestions": up to 3 specific, useful next steps that follow from the day (for example: finish or share a document they edited a lot, follow up on a question they asked, organize files they uploaded). Never invent files or facts.
Use only the log, and describe each file with exactly the actions logged for it (opened, downloaded, edited...). Never mention things that did not happen or judge how much was done. Be warm but concise.`,
        content: 'Log of the day:\n{{CONTEXT}}',
        context: factsForModel(facts),
        format: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            highlights: { type: 'array', items: { type: 'string' } },
            suggestions: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'highlights', 'suggestions'],
        },
      });
      const parsed = JSON.parse(raw);
      const clean = (list, n) => (Array.isArray(list) ? list : []).map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, n);
      result = { summary: String(parsed.summary || '').trim(), highlights: clean(parsed.highlights, 5), suggestions: clean(parsed.suggestions, 3) };
      if (!result.summary) throw new Error('empty summary');
    } catch (error) {
      console.error('[Daily summary] Using a basic summary:', error.message);
    }
  }
  if (!result) {
    result = basicSummary(facts);
    basic = true;
  }

  await DailySummary.findOneAndUpdate(
    { user: userId, date: facts.date },
    { $set: { ...result, basic, factsHash: hashFacts(facts), model: basic ? '' : config.ollama.assistantModel } },
    { upsert: true }
  );
  return { ...result, basic, generatedAt: new Date() };
}

module.exports = { dayFacts, recentDays, writeSummary, startSummary, isWriting, cachedSummary, localDate, dayRange };
