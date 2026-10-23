const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { INTENTS } = require('./intentRouter');

/**
 * The local model reads every File Box AI request and says what the user wants, as structured JSON.
 * Code then only keeps things safe: permissions, confirmations, and asking when several files match.
 * (intentRouter's rules are used only when Ollama is not running.)
 */

const ACTIONS = [
  'none',
  'create_folder',
  'create_file',
  'rename_file',
  'move_file',
  'share_file',
  'delete_file',
  'star_file',
  'restore_file',
  'create_file_request',
  'create_shortcut',
  'create_secured_link',
  'create_template',
  'create_team_folder',
  'create_cloud_backup',
];
const LOOK_FOR = ['what_the_file_is', 'words_inside_files', 'none'];
const SELECTED = 'SELECTED';

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    action: { type: 'string', enum: ACTIONS },
    file: { type: 'string' },
    destination: { type: 'string' },
    newName: { type: 'string' },
    searchTerms: { type: 'string' },
    lookFor: { type: 'string', enum: LOOK_FOR },
  },
  required: ['intent', 'action', 'file', 'destination', 'newName', 'searchTerms', 'lookFor'],
};

// Kept short on purpose: Ollama re-reads the whole prompt whenever its cache was used for something else,
// and on a laptop every 1,000 prompt tokens cost about 8 seconds.
const SYSTEM = `You read requests for File Box AI in a personal file storage app. Return JSON.
intent:
- search / smart_search: find files (which, where, do I have, show me my X). lookFor "what_the_file_is" for a kind of file, "words_inside_files" for files that mention words.
- summarize, explain: one file.
- file_question: a question about what one named or selected file says ("does my resume mention X").
- drive_question: asks for a fact written in their files (a date, amount, grade, course) without naming a file.
- duplicates: anything about duplicate or identical copies, including cleaning them up.
- organize: tidy or group files into folders (not about duplicates).
- action: one change now. help: how File Box works. chat: anything else.
action (only for intent action): create_folder, create_file, rename_file, move_file, share_file (also "as a link"), delete_file (trash/delete/remove), star_file, restore_file, create_file_request, create_template, create_team_folder, create_cloud_backup, create_shortcut / create_secured_link (website URLs). Otherwise "none".
file: the file meant, in the user's words without filler; "${SELECTED}" for "this/it" when a file is selected; for "it" after "[Files shown: X]" copy X.
destination: folder for move_file. newName: new name for rename_file, or the name for create_folder/create_file. searchTerms: words for search.
"How do I" is always help. Use "" for fields that do not apply.`;

// Worked examples, given to the model as earlier turns (followed more reliably than a list in the prompt).
// Only the fields that matter are written out; the rest default to empty.
const example = (message, answer, extra = {}) => ({
  user: JSON.stringify({ c: extra.history || [], sel: Boolean(extra.selected), m: message }),
  assistant: JSON.stringify({ intent: 'chat', action: 'none', file: '', destination: '', newName: '', searchTerms: '', lookFor: 'none', ...answer }),
});
const EXAMPLES = [
  example('Move report into Archive', { intent: 'action', action: 'move_file', file: 'report', destination: 'Archive' }),
  example('Put the photo in Pictures', { intent: 'action', action: 'move_file', file: 'photo', destination: 'Pictures' }),
  example('Trash report', { intent: 'action', action: 'delete_file', file: 'report' }),
  example('Create a folder called Trips', { intent: 'action', action: 'create_folder', newName: 'Trips' }),
  example('rename notes.txt to ideas.txt', { intent: 'action', action: 'rename_file', file: 'notes.txt', newName: 'ideas.txt' }),
  example('Share the plan with ana@example.com', { intent: 'action', action: 'share_file', file: 'plan' }),
  example('share it as a link', { intent: 'action', action: 'share_file', file: 'trip.pdf' }, { history: [{ role: 'assistant', content: '[Files shown: trip.pdf]' }] }),
  example('Organize my screenshots', { intent: 'organize' }),
  example('Find duplicate files', { intent: 'duplicates' }),
  example('Clean up the duplicates in my drive', { intent: 'duplicates' }),
  example('Show me my receipts', { intent: 'smart_search', searchTerms: 'receipts', lookFor: 'what_the_file_is' }),
  example('Find 4417', { intent: 'smart_search', searchTerms: '4417', lookFor: 'what_the_file_is' }),
  example('Find the contract in trash', { intent: 'smart_search', searchTerms: 'contract', lookFor: 'what_the_file_is' }),
  example('Which files mention Kubernetes?', { intent: 'smart_search', searchTerms: 'Kubernetes', lookFor: 'words_inside_files' }),
  example('Do I have a passport scan?', { intent: 'smart_search', searchTerms: 'passport scan', lookFor: 'what_the_file_is' }),
  example('Does my cover letter mention Java?', { intent: 'file_question', file: 'cover letter' }),
  example('What does this say about refunds?', { intent: 'file_question', file: SELECTED }, { selected: true }),
  example('When is my rent due?', { intent: 'drive_question' }),
  example('Summarize the lease', { intent: 'summarize', file: 'lease' }),
  example('How do I restore a file?', { intent: 'help' }),
  example('hi there', { intent: 'chat' }),
];

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * When the model's fields contradict the label it chose, the fields win. This never reads the user's words
 * for meaning; it only keeps the model consistent with what it extracted itself.
 */
function reconcile(parsed, question) {
  const file = clean(parsed.file);
  const destination = clean(parsed.destination);
  // A specific file and a destination folder is a move ("Move report into Archive"), not tidying up.
  if (file && destination && parsed.action !== 'move_file' && !['help', 'duplicates'].includes(parsed.intent)) {
    return { intent: 'action', action: 'move_file' };
  }
  // Shortcuts and secured links save website addresses; for a file with no address, sharing is meant.
  if (['create_secured_link', 'create_shortcut'].includes(parsed.action) && file && !/https?:\/\/|www\.|\.[a-z]{2,6}\//i.test(question)) {
    return { intent: 'action', action: 'share_file' };
  }
  return { intent: parsed.intent, action: parsed.action };
}

/**
 * Returns a route: { intent, action?, target, destination, newName, searchTerms, lookFor, source: 'model' }.
 * Throws when the model is unreachable; the caller then uses the offline rules.
 */
async function understandRequest(question, { hasSelectedFile = false, history = [] } = {}) {
  const raw = await ollamaClient.chat({
    task: 'plan',
    model: config.ollama.understandingModel,
    system: SYSTEM,
    examples: EXAMPLES,
    content: JSON.stringify({
      c: history.slice(-4).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 300) })),
      sel: hasSelectedFile,
      m: question,
    }),
    format: SCHEMA,
  });

  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || !INTENTS.includes(parsed.intent)) {
    return { intent: 'chat', source: 'model', rule: 'model:invalid-output', confidence: 0.3, target: '', normalized: question };
  }

  ({ intent: parsed.intent, action: parsed.action } = reconcile(parsed, question));
  const action = parsed.intent === 'action' && ACTIONS.includes(parsed.action) && parsed.action !== 'none' ? parsed.action : undefined;
  let target = clean(parsed.file);
  if (target === SELECTED) target = hasSelectedFile ? 'this' : '';
  return {
    intent: parsed.intent,
    action,
    target,
    destination: clean(parsed.destination),
    newName: clean(parsed.newName),
    searchTerms: clean(parsed.searchTerms),
    lookFor: LOOK_FOR.includes(parsed.lookFor) ? parsed.lookFor : 'none',
    source: 'model',
    rule: 'model:understand',
    confidence: 0.8,
    normalized: question,
  };
}

module.exports = { understandRequest, ACTIONS };
