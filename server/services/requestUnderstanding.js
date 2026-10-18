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
  drive_question (a question whose answer is written somewhere in the user's files, without naming a file:
  "When is my electricity bill due?", "What grade did I get in calculus?", "How much was my last phone bill?"),
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

"How do I ..." questions are help, never actions. Use empty strings for fields that do not apply.

Examples:
"Move report into Archive" -> {"intent":"action","action":"move_file","file":"report","destination":"Archive"}
"Put the screenshot in Screenshots" -> {"intent":"action","action":"move_file","file":"screenshot","destination":"Screenshots"}
"Trash report" -> {"intent":"action","action":"delete_file","file":"report"}
"Share minutes as a link" -> {"intent":"action","action":"share_file","file":"minutes"}
"Share the plan with ana@example.com" -> {"intent":"action","action":"share_file","file":"plan"}
"Share it as a link" (the conversation shows "[Files shown: <name>]") -> {"intent":"action","action":"share_file","file":"<name>"}
"Organize my screenshots" -> {"intent":"organize","action":"none"}
"Find my resume" -> {"intent":"smart_search","searchTerms":"resume","lookFor":"what_the_file_is"}
"Which files mention Kubernetes?" -> {"intent":"smart_search","searchTerms":"Kubernetes","lookFor":"words_inside_files"}
"invoice" -> {"intent":"search","searchTerms":"invoice","lookFor":"what_the_file_is"}
"Do I have a passport scan?" -> {"intent":"smart_search","searchTerms":"passport scan","lookFor":"what_the_file_is"}
"Have I uploaded my lease?" -> {"intent":"smart_search","searchTerms":"lease","lookFor":"what_the_file_is"}
"What is the deadline in the project plan?" -> {"intent":"file_question","file":"project plan"}
"Does my cover letter mention Java?" -> {"intent":"file_question","file":"cover letter"}
"When is my rent due?" -> {"intent":"drive_question"}
"What was my GPA last semester?" -> {"intent":"drive_question"}
"Which certificates do I have?" -> {"intent":"smart_search","searchTerms":"certificates","lookFor":"what_the_file_is"}
"Create a folder called Trips" -> {"intent":"action","action":"create_folder","newName":"Trips"}`;

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Returns a route: { intent, action?, target, destination, newName, searchTerms, lookFor, source: 'model' }.
 * Throws when the model is unreachable; the caller then uses the offline rules.
 */
async function understandRequest(question, { hasSelectedFile = false, history = [] } = {}) {
  const raw = await ollamaClient.chat({
    task: 'plan',
    model: config.ollama.plannerModel,
    system: SYSTEM,
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
