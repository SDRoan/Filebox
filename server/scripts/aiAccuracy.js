#!/usr/bin/env node
/**
 * File Box AI accuracy test set: `npm run test:ai` (from server/).
 *
 * Builds a throwaway database from ai-accuracy/fixtures.js, lets File Box AI read every file (the same
 * profiler and passage index the app uses), then checks every case in ai-accuracy/cases.json and prints
 * a score per area. Needs Ollama running with the configured models.
 *
 *   --live      also run ai-accuracy/live-cases.json (made from your 👎 feedback, see
 *               scripts/exportAiFeedback.js) against your real data, read-only.
 *   --strict    exit with an error when any case fails.
 *   --only=area run one area: understanding, search, questions, privacy.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const ACCURACY_DB = process.env.AI_ACCURACY_MONGODB_URI || 'mongodb://localhost:27017/filebox-ai-accuracy';
const args = new Set(process.argv.slice(2));
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

const root = path.join(__dirname, '..', 'ai-accuracy');
const fixtures = require(path.join(root, 'fixtures.js'));
const cases = JSON.parse(fs.readFileSync(path.join(root, 'cases.json'), 'utf8'));

const File = require('../models/File');
const FileContent = require('../models/FileContent');
const User = require('../models/User');
const { profileFile } = require('../services/fileProfiler');
const { indexFile } = require('../services/fileIndex');
const { understandRequest } = require('../services/requestUnderstanding');
const assistant = require('../services/ollamaWorkspaceAssistant');

const matches = (text, expected) => {
  if (expected.startsWith('/')) return new RegExp(expected.slice(1, expected.lastIndexOf('/')), 'i').test(text);
  return text.toLowerCase().includes(expected.toLowerCase());
};

function report(area, results) {
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${area}: ${passed}/${results.length}`);
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}\n      ${r.detail}`));
  return { area, passed, total: results.length };
}

async function seed() {
  if (!/test|accuracy/i.test(ACCURACY_DB)) throw new Error(`Refusing to reset ${ACCURACY_DB}: the accuracy database name must contain "test" or "accuracy".`);
  await mongoose.connect(ACCURACY_DB);
  await mongoose.connection.dropDatabase();
  const users = {};
  for (const label of fixtures.users) {
    users[label] = await User.create({ name: `${label} accuracy`, email: `${label}@ai-accuracy.test`, password: 'Accuracy-Test-1' });
  }
  const names = new Map();
  for (const fixture of fixtures.files) {
    const file = await File.create({
      name: fixture.name,
      originalName: fixture.name,
      path: `/ai-accuracy/${fixture.name}`,
      size: Buffer.byteLength(fixture.text),
      mimeType: 'text/plain',
      owner: users[fixture.owner]._id,
    });
    const content = await FileContent.create({ file: file._id, extractedText: fixture.text, extractionStatus: 'completed', extractedAt: new Date() });
    names.set(file._id.toString(), fixture.name);
    process.stdout.write(`Reading ${fixture.name}... `);
    const profile = await profileFile(file, content);
    await indexFile(file, await FileContent.findById(content._id));
    console.log(profile ? `${profile.aiCategory} / ${profile.aiType}` : '(no profile)');
  }
  return users;
}

async function runUnderstanding() {
  const results = [];
  for (const c of cases.understanding) {
    const r = await understandRequest(c.message, { history: c.history || [], hasSelectedFile: Boolean(c.selected) });
    const e = c.expect;
    const ok = e.intent.split('|').includes(r.intent) && (!e.action || r.action === e.action)
      && (!e.file || r.target.toLowerCase() === e.file.toLowerCase()) && (!e.destination || r.destination === e.destination)
      && (!e.newName || r.newName === e.newName) && (!e.lookFor || r.lookFor === e.lookFor);
    results.push({ ok, name: c.message, detail: `got ${r.intent}/${r.action || ''} file="${r.target}" dest="${r.destination}" new="${r.newName}" lookFor=${r.lookFor}` });
  }
  return report('Understanding requests', results);
}

async function runSearch(users) {
  const results = [];
  for (const c of cases.search) {
    const reply = await assistant.chat({ userId: users[c.user || 'owner']._id, question: c.message });
    const found = (reply.files || []).map(f => f.name);
    const ok = c.expectFiles.every(n => found.includes(n)) && (c.expectFiles.length || !found.length)
      && !(c.notFiles || []).some(n => found.includes(n));
    results.push({ ok, name: c.message, detail: `found [${found.join(', ')}], expected [${c.expectFiles.join(', ')}]${c.notFiles ? `, not [${c.notFiles.join(', ')}]` : ''}` });
  }
  return report('Finding files', results);
}

async function runQuestions(users, list, area) {
  const results = [];
  for (const c of list) {
    const reply = await assistant.chat({ userId: users[c.user || 'owner']._id, question: c.message });
    const answer = reply.answer || '';
    const shown = (reply.files || []).map(f => f.name);
    const ok = (!c.expectText || matches(answer, c.expectText))
      && (!c.expectFile || answer.includes(c.expectFile) || shown.includes(c.expectFile))
      && !(c.mustNotContain || []).some(t => answer.includes(t));
    results.push({ ok, name: c.message, detail: `answer: ${answer.replace(/\s+/g, ' ').slice(0, 200)}` });
  }
  return report(area, results);
}

/** Cases made from feedback on real answers; read-only questions against the real account. */
async function runLive() {
  const livePath = path.join(root, 'live-cases.json');
  if (!fs.existsSync(livePath)) {
    console.log('\nLive cases: none yet (export them from feedback with scripts/exportAiFeedback.js).');
    return null;
  }
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  await mongoose.disconnect();
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/filebox');
  const results = [];
  for (const c of live.cases) {
    const reply = await assistant.chat({ userId: c.userId, question: c.message });
    const found = (reply.files || []).map(f => f.id);
    const ok = (!c.expectFileId || found.includes(c.expectFileId)) && (!c.notFileId || !found.includes(c.notFileId));
    results.push({ ok, name: c.message, detail: `files [${(reply.files || []).map(f => f.name).join(', ')}]${c.note ? ` | note: ${c.note}` : ''}` });
  }
  return report('Live cases from your feedback', results);
}

(async () => {
  const started = Date.now();
  console.log(`File Box AI accuracy test (models: ${require('../config/aiConfig').ollama.assistantModel}, database: ${ACCURACY_DB})\n`);
  const users = await seed();
  const scores = [];
  if (!only || only === 'understanding') scores.push(await runUnderstanding());
  if (!only || only === 'search') scores.push(await runSearch(users));
  if (!only || only === 'questions') scores.push(await runQuestions(users, cases.questions, 'Answering from files'));
  if (!only || only === 'privacy') scores.push(await runQuestions(users, cases.privacy, 'Privacy (other accounts)'));
  await mongoose.connection.dropDatabase();
  if (args.has('--live')) {
    const live = await runLive();
    if (live) scores.push(live);
  }
  const passed = scores.reduce((n, s) => n + s.passed, 0);
  const total = scores.reduce((n, s) => n + s.total, 0);
  console.log(`\nTotal: ${passed}/${total} (${Math.round((100 * passed) / Math.max(total, 1))}%) in ${Math.round((Date.now() - started) / 1000)}s`);
  await mongoose.disconnect();
  process.exit(args.has('--strict') && passed < total ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
