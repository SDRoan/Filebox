/**
 * Offline understanding for File Box AI. When Ollama is running, the local model reads every request
 * (services/requestUnderstanding.js). When it is not, these simple rules stand in so search, choices and
 * plain commands keep working; replies are marked offline.
 *
 * Every route carries debug metadata: { intent, action?, source: 'rule' | 'offline', rule, confidence }.
 */

const INTENTS = [
  'search', // a few keywords: "resume", "budget.pdf"
  'smart_search', // a question about which file: "Which file mentions MongoDB?"
  'summarize',
  'explain',
  'file_question', // a question about one file's contents
  'drive_question', // a question answered from what is written in the user's files, no file named
  'organize',
  'duplicates',
  'action', // one specific change: create folder, rename, move, star, share, trash, restore, ...
  'help', // how File Box works
  'chat',
];

// Phrases that only point at "the file I'm looking at" rather than naming one.
const SELF_REFERENCE = /^(?:(?:this|that|it|the selected|the current|the open|selected)(?:\s+(?:one|file|document|doc|pdf|code|script|image|photo|picture|screenshot|spreadsheet|sheet|resume|cv|report|presentation|deck|note|notes|text))?)$/i;

// Phrases that point at the files the person has selected ("move these into School").
const SELECTION_REFERENCE = /^(?:these|those|them|both(?: of them)?|all of them|all (?:these|those)|(?:these|those|the selected|selected) (?:files?|items?|ones|documents?|pictures?|photos?))$/i;

// Changing the previous answer ("make it shorter", "in bullet points"): a follow-up, not a new task.
const FOLLOW_UP_EDIT = /^(?:(?:can|could) you\s+|please\s+|now\s+|ok(?:ay)?,?\s+)?(?:make (?:it|that|this) (?:shorter|longer|simpler|clearer|more \w+|less \w+|easier(?: to understand)?)|shorter|longer|simpler|(?:explain|say) (?:it|that) (?:again|differently|more simply|in simpler words)|(?:put it|write it|give it(?: to me)?|show it) (?:as|in) (?:bullet points|bullets|a list|a table|one sentence|\d+ words)|in (?:bullet points|bullets|one sentence|plain english|simpler words)|more detail|go deeper|tl;?dr|rephrase(?: (?:it|that))?)\b/i;

// A question about "it" / "this" (the file the person is looking at), not a search across files.
const POINTS_AT_FOCUS = /\b(?:it|its|this|that|this (?:file|document|doc|pdf|picture|image|photo|one)|the (?:file|document|pdf|picture|image))\b/i;

// Phrases that point at the folder the person is in ("move it here", "in this folder").
const HERE_REFERENCE = /^(?:here|in here|this folder|the current folder|current folder|this one|the folder i'?m in|where i am)$/i;

const NOT_A_FILE = /^(?:drive|my drive|files|folders|documents|everything|trash|bin|account|file box|workspace|team spaces?|shared(?: files)?)$/i;

const QUESTION_START = /^(?:what|when|who|whom|whose|why|how|does|do|did|is|are|was|were|has|have|can|could|will|would|should|list|tell me|give me|show me the)\b/i;

const SEARCH_START = /^(?:find|search(?:\s+for)?|look\s+(?:for|up)|locate|get\s+me|show\s+me\s+(?:my|all|the|every|files?|documents?)|where(?:'s|\s+is|\s+are|\s+did\s+i\s+(?:put|save|leave))|which\s+(?:of\s+(?:my|the)\s+)?[\w-]+|do\s+i\s+have|have\s+i\s+got|is\s+there\s+(?:a|any)|are\s+there\s+any|any\s+files?|what\s+files?)\b/i;

const VERB_START = /^(?:find|search|look|locate|get|show|where|which|what|who|when|why|how|does|do|did|is|are|can|could|would|should|will|create|make|add|new|rename|move|put|transfer|share|send|give|delete|trash|remove|bin|throw|star|favou?rite|bookmark|pin|restore|recover|undelete|bring|summari[sz]e|explain|organi[sz]e|tidy|sort|group|clean|write|tell|help|set|upload|download|open|copy|list)\b/i;

const GREETING = /^(?:hi|hello|hey|yo|thanks|thank you|thx|good (?:morning|afternoon|evening)|what can you do|who are you|what are you)\b/i;

const HELP = /^(?:how\s+(?:do|can|should|would|does|is|are)\b|how\s+to\b|can\s+i\b|is\s+it\s+possible|where\s+do\s+i\b|what\s+happens\s+(?:when|if)\b|what(?:'s|\s+is|\s+are)\s+(?:the\s+difference|version\s+history|a\s+team\s+space|team\s+spaces|file\s+box|a\s+share\s+link|trash)\b|why\s+(?:can't|cannot|can\s+not|does|is|did)\b|explain\s+how\b|walk\s+me\s+through|guide\s+me|show\s+me\s+how|help[.!?]*$)/i;

const PLEASE = /^(?:(?:hey\s+)?file\s*box[,:]?\s+)?(?:please\s+|pls\s+|kindly\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+)?(?:help\s+me\s+(?:to\s+)?(?=find|locate|search|look))?/i;

/** Strip politeness and rewrite "find X and delete it" to "delete X", so the rules see the command. */
function normalize(question = '') {
  let q = String(question).replace(/\s+/g, ' ').trim();
  q = q.replace(PLEASE, '').replace(/[\s,]+please[.!?]*$/i, '').trim();
  const compound = q.match(/^(?:find|locate|search\s+for|look\s+for)\s+(.+?)\s+and\s+(delete|trash|remove|star|share|move|rename|restore)\s+(?:it|them|that)\b\s*(.*)$/i);
  if (compound) q = `${compound[2]} ${compound[1]}${compound[3] ? ` ${compound[3]}` : ''}`;
  return q;
}

const cleanTail = (value = '') => value.replace(/^["'`]+|["'`]+$/g, '').replace(/[\s.!?]+$/g, '').trim();

/**
 * The file and folder phrases a request refers to, by rule. Used for every route, including model-routed
 * ones, so resolving names never depends on the model. Returns { target, destination, newName }.
 */
function extractTargets(intent, action, q) {
  let m;
  switch (action || intent) {
    case 'rename_file':
      // Split at the first " to "/" as " after the old name; a file name with an extension ends the old name.
      m = q.match(/^(?:rename|change\s+the\s+name\s+of)\s+(.+?\.\w{1,5})\s+(?:to|as)\s+(.+)$/i)
        || q.match(/^(?:rename|change\s+the\s+name\s+of)\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
      return m ? { target: cleanTail(m[1]), newName: cleanTail(m[2]) } : { target: '' };
    case 'move_file':
      // "into" is the clearest separator, then "to", then "inside"/"under", then "in".
      for (const prep of ['into', 'to', 'inside|under', 'in']) {
        m = q.match(new RegExp(`^(?:move|put|transfer)\\s+(.+?)\\s+(?:${prep})\\s+(.+)$`, 'i'));
        if (m) break;
      }
      return m ? { target: cleanTail(m[1]), destination: cleanTail(m[2]) } : { target: cleanTail(q.replace(/^(?:move|put|transfer)\s+/i, '')) };
    case 'share_file':
      m = q.match(/^(?:share|send)\s+(.+?)(?:\s+(?:with|to)\s+.+|\s+(?:as|via|by|using)\s+(?:a\s+)?(?:public\s+|view(?:-only)?\s+)?link.*|\s+publicly)?$/i);
      return { target: cleanTail(m ? m[1] : '') };
    case 'delete_file':
      m = q.match(/^(?:delete|trash|remove|bin|throw\s+away|get\s+rid\s+of)\s+(.+?)(?:\s+(?:to|into|in)\s+(?:the\s+)?(?:trash|bin))?$/i);
      return { target: cleanTail(m ? m[1] : '') };
    case 'star_file':
      m = q.match(/^(?:star|favou?rite|bookmark|pin)\s+(.+)$/i);
      return { target: cleanTail(m ? m[1] : '') };
    case 'restore_file':
      m = q.match(/^(?:restore|recover|undelete|bring\s+back)\s+(.+?)(?:\s+(?:from|out\s+of)\s+(?:the\s+)?(?:trash|bin))?$/i);
      return { target: cleanTail(m ? m[1] : '') };
    case 'summarize':
      m = q.match(/(?:summari[sz]e|summary\s+of|sum\s+up|recap(?:\s+of)?|gist\s+of|tl;?dr\s+(?:of|for))\s+(.+)$/i);
      return { target: cleanTail(m ? m[1] : '').replace(/\s+(?:for\s+me|briefly|quickly|in\s+.+)$/i, '') };
    case 'explain':
      m = q.match(/^explain\s+(.+?)(?:\s+(?:simply|in\s+simple\s+(?:terms|words|language)|like\s+i'?m\s+\w+|to\s+me|for\s+me|briefly))*$/i);
      return { target: cleanTail(m ? m[1] : '') };
    case 'file_question': {
      m = q.match(/^(?:does|do|did|is|are|has|have|can|will)\s+((?:my|the|this|that)\s+.+?)\s+(?:mention|say|contain|include|list|have|talk\s+about|cover|state|show|refer\s+to)s?\b/i)
        || q.match(/\b(?:in|from|of|inside|within)\s+((?:my|the|this|that)\s+.+?)\s*$/i);
      return { target: cleanTail(m ? m[1] : '') };
    }
    default:
      return { target: '' };
  }
}

/** Specific actions. The verb has to lead the request; a verb somewhere in a sentence is not enough. */
function actionByRule(q) {
  const lower = q.toLowerCase();
  // Creating things other than folders keeps the existing patterns.
  if (/^(?:create|make|new|add|set\s+up|setup|start)\b/i.test(q)) {
    if (/\b(?:team\s+(?:folder|space)|teamspace)\b/i.test(q)) return 'create_team_folder';
    if (/\bfile\s+request\b/i.test(q)) return 'create_file_request';
    if (/\bsecured?\s+link\b/i.test(q)) return 'create_secured_link';
    if (/\bshortcut\b/i.test(q)) return 'create_shortcut';
    if (/\btemplate\b/i.test(q)) return 'create_template';
    if (/\bbackup\b/i.test(q)) return 'create_cloud_backup';
    if (/\bfolder\b/i.test(q)) return 'create_folder';
    if (/\b(?:pdf|docx?|word|text|txt)?\s*(?:file|document|doc|note)\b/i.test(q)) return 'create_file';
  }
  if (/^(?:back\s*up|backup)\s+my\s+(?:desktop|documents)\b/i.test(q)) return 'create_cloud_backup';
  if (/^(?:restore|recover|undelete|bring\s+back)\b/i.test(q)) return 'restore_file';
  if (/^(?:rename|change\s+the\s+name\s+of)\b/i.test(q)) return 'rename_file';
  if (/^(?:move|put|transfer)\s+.+\s+(?:into|to|inside|under|in)\s+\S/i.test(q)) return 'move_file';
  if (/^share\b/i.test(q) || /^send\s+.+\s+(?:as\s+a\s+link|a\s+link)\b/i.test(q)) return 'share_file';
  // "remove Sarah's access" or "remove the star" are not trash requests.
  if (/^(?:delete|trash|remove|bin|throw\s+away|get\s+rid\s+of)\b/i.test(q) && !/\b(?:access|star|share|sharing|link|permission|member)\b/i.test(lower)) return 'delete_file';
  if (/^(?:star|favou?rite|pin)\b/i.test(q) || (/^bookmark\b/i.test(q) && !/\b(?:website|site|url|https?:)/i.test(q))) return 'star_file';
  if (/\b(?:relate|relationship)\b/i.test(q) || /^(?:connect|link)\s+\S+\.\w+\s+(?:and|with|to)\s+\S+\.\w+/i.test(q)) return 'create_relationship';
  return null;
}

const rule = (intent, ruleId, confidence, extra = {}) => ({ intent, source: 'rule', rule: ruleId, confidence, ...extra });

/** Deterministic classification. Returns a route, or null when no rule is confident. */
function routeByRules(question, { hasSelectedFile = false, fileNames = [] } = {}) {
  const q = normalize(question);
  if (!q) return rule('chat', 'empty', 1);
  const isQuestion = /\?\s*$/.test(q) || QUESTION_START.test(q);

  if (GREETING.test(q) && q.split(/\s+/).length <= 6) return rule('chat', 'greeting', 0.95);
  if (HELP.test(q)) return rule('help', 'how-to', 0.95);
  if (/\b(?:duplicates?|duplicated|identical\s+files|same\s+file\s+twice)\b/i.test(q)) return rule('duplicates', 'duplicates', 0.95);

  const action = actionByRule(q);
  if (action) return rule('action', `action:${action}`, 0.95, { action });

  if (/\b(?:organi[sz]e|tidy(?:\s+up)?|declutter|sort\s+(?:out\s+)?(?:my|these|the|all)|group\s+(?:these|my|the|all|similar)|clean\s+up\s+(?:my|this|the)\s+(?:files|drive|folder|downloads|desktop))\b/i.test(q)) {
    return rule('organize', 'organize', 0.95);
  }
  if (/\b(?:summari[sz]e|summary|sum\s+up|tl;?dr|gist|recap)\b/i.test(q)) return rule('summarize', 'summarize', 0.95);
  if (/^explain\b/i.test(q)) return rule('explain', 'explain', 0.95);

  // A question that names its file ("this file", "my resume mentions", "in budget.pdf") is about that file,
  // unless it asks which file / where a file is.
  if (!SEARCH_START.test(q)) {
    const { target } = extractTargets('file_question', null, q);
    const named = target && !NOT_A_FILE.test(target.replace(/^(?:my|the|this|that)\s+/i, ''));
    if (isQuestion && (named || fileNames.length || /\b(?:this|that|the\s+selected)\s+(?:file|document|doc|pdf|code|resume|cv|report|image|spreadsheet|sheet|presentation)\b/i.test(q))) {
      return rule('file_question', named ? 'file-question:named' : fileNames.length ? 'file-question:file-name' : 'file-question:this', 0.9);
    }
  }

  if (SEARCH_START.test(q) || /\b(?:newest|latest|most\s+recent|oldest|biggest|largest)\b/i.test(q) && /\b(?:my|the)\b/i.test(q)) {
    return rule('smart_search', 'search-question', 0.9);
  }
  if (hasSelectedFile && isQuestion) return rule('file_question', 'file-question:selected', 0.85);

  // A few words with no verb and no question: look them up by name ("resume", "budget.pdf").
  const words = q.split(/\s+/);
  if (words.length <= 4 && !isQuestion && !VERB_START.test(q) && !GREETING.test(q)) return rule('search', 'keywords', 0.8);

  return null;
}

/** Route a request by rules. Requests no rule understands come back as offline general chat. */
function routeIntent(question, options = {}) {
  const q = normalize(question);
  const byRule = routeByRules(question, options);
  if (byRule) return { ...byRule, ...extractTargets(byRule.intent, byRule.action, q), normalized: q };
  return { intent: 'chat', source: 'offline', rule: 'offline:no-rule', confidence: 0, target: '', normalized: q };
}

module.exports = {
  INTENTS,
  SELF_REFERENCE, SELECTION_REFERENCE, HERE_REFERENCE, FOLLOW_UP_EDIT, POINTS_AT_FOCUS, QUESTION_START, SEARCH_START,
  normalize,
  routeByRules,
  routeIntent,
  extractTargets,
};
