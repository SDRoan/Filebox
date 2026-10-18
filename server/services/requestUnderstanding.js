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

const SYSTEM = `You are the understanding step of File Box AI, an assistant inside a personal file storage app.
Read the user's latest message (and the recent conversation for context) and return JSON describing what they want.

Fields:
- intent: one of
  search (a few words to look up a file), smart_search (asks to find files or which/where a file is),
  summarize, explain, file_question (a question about what is written inside one specific file the user names or selected),
  drive_question (asks for a fact written inside their files - a date, amount, grade, name, number - without
  naming a file: "When is my electricity bill due?", "What grade did I get in calculus?").
  Asking WHICH file, WHETHER they have a file, or WHERE a file is, is smart_search, not drive_question,
  organize (the user wants File Box to suggest how to tidy or group their files, with no specific file and folder named),
  duplicates (find or clean up duplicate files),
  action (make one specific change now, such as moving a named file into a named folder),
  help (how File Box works), chat (anything else).
- action: when intent is action, the change: create_folder, create_file, rename_file, move_file, share_file,
  delete_file (trash, delete, remove or move a file to Trash), star_file, restore_file (from Trash),
  create_file_request, create_template, create_team_folder, create_cloud_backup,
  create_shortcut (save a website URL), create_secured_link (save a website URL behind a password).
  Sharing a file, including "as a link" or "with a link", is always share_file. Otherwise "none".
- file: the file the message is about, in the user's own words without filler (for example "budget.pdf",
  "resume", "old report"). If they mean the file they have selected ("this", "it", "this PDF") and a file is
  selected, use "${SELECTED}". If "it", "that one" or "the first one" refers to a file listed earlier in the
  conversation (after "[Files shown: ...]"), copy that file's exact name from the list. Empty when no file is meant.
- destination: for move_file, the folder to move into, in the user's words without "the" or "folder".
- newName: for rename_file, the new name exactly as given; for create_folder or create_file, the name to create.
- searchTerms: for search and smart_search, the few words that describe the file they want. When the whole
  message is just a few words like "resume" or "budget.pdf", those words.
- lookFor: for search and smart_search, "what_the_file_is" when they want a file that IS something
  (my resume, my tax return, the budget), or "words_inside_files" when they ask which files mention or contain
  some words. Otherwise "none".

"How do I ..." questions are help, never actions. Use empty strings for fields that do not apply.`;

// Worked examples, given to the model as earlier turns (small models follow these more reliably).
const blank = { intent: 'chat', action: 'none', file: '', destination: '', newName: '', searchTerms: '', lookFor: 'none' };
const example = (message, answer, extra = {}) => ({
  user: JSON.stringify({ recentConversation: extra.history || [], fileSelected: Boolean(extra.selected), message }),
  assistant: JSON.stringify({ ...blank, ...answer }),
});
const EXAMPLES = [
  example('Move report into Archive', { intent: 'action', action: 'move_file', file: 'report', destination: 'Archive' }),
  example('Trash report', { intent: 'action', action: 'delete_file', file: 'report' }),
  example('Create a folder called Trips', { intent: 'action', action: 'create_folder', newName: 'Trips' }),
  example('rename notes.txt to ideas.txt', { intent: 'action', action: 'rename_file', file: 'notes.txt', newName: 'ideas.txt' }),
  example('Share the plan with ana@example.com', { intent: 'action', action: 'share_file', file: 'plan' }),
  example('share it as a link', { intent: 'action', action: 'share_file', file: 'trip.pdf' }, { history: [{ role: 'assistant', content: 'I found 1 file.\n[Files shown: trip.pdf]' }] }),
  example('Organize my screenshots', { intent: 'organize' }),
  example('Find duplicate files', { intent: 'duplicates' }),
  example('Find my resume', { intent: 'smart_search', searchTerms: 'resume', lookFor: 'what_the_file_is' }),
  example('Which files mention Kubernetes?', { intent: 'smart_search', searchTerms: 'Kubernetes', lookFor: 'words_inside_files' }),
  example('Do I have a passport scan?', { intent: 'smart_search', searchTerms: 'passport scan', lookFor: 'what_the_file_is' }),
  example('Show me my receipts', { intent: 'smart_search', searchTerms: 'receipts', lookFor: 'what_the_file_is' }),
  example('invoice', { intent: 'search', searchTerms: 'invoice', lookFor: 'what_the_file_is' }),
  example('Does my cover letter mention Java?', { intent: 'file_question', file: 'cover letter' }),
  example('What does this say about refunds?', { intent: 'file_question', file: SELECTED }, { selected: true }),
  example('When is my rent due?', { intent: 'drive_question' }),
  example('How much did I pay for internet in May?', { intent: 'drive_question' }),
  example('Do I have a tax return?', { intent: 'smart_search', searchTerms: 'tax return', lookFor: 'what_the_file_is' }),
  example('Which file mentions the Q3 budget?', { intent: 'smart_search', searchTerms: 'Q3 budget', lookFor: 'words_inside_files' }),
  example('Put the photo in Pictures', { intent: 'action', action: 'move_file', file: 'photo', destination: 'Pictures' }),
  example('Summarize the lease', { intent: 'summarize', file: 'lease' }),
  example('How do I restore a file?', { intent: 'help' }),
  example('hi there', { intent: 'chat' }),
];

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);

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
      recentConversation: history.slice(-6).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 600) })),
      fileSelected: hasSelectedFile,
      message: question,
    }),
    format: SCHEMA,
  });

  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || !INTENTS.includes(parsed.intent)) {
    return { intent: 'chat', source: 'model', rule: 'model:invalid-output', confidence: 0.3, target: '', normalized: question };
  }

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
