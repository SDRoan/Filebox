const File = require('../models/File');
const FileContent = require('../models/FileContent');

/**
 * What kind of document a file is, for Advanced Search: one category (Work, School, Financial, Personal,
 * Other), one document type inside it, and up to 5 topics. This is metadata only; it never moves a file.
 *
 * The automatic classification comes from, in this order of trust:
 *   1. a strong keyword rule (two or more independent signals in the name and text)
 *   2. the background profile's aiCategory, mapped onto the taxonomy
 *   3. a weak keyword rule (one signal)
 *   4. the file's format (a picture is a Photo or Screenshot, code is Source Code), otherwise Other / Unknown
 * No AI runs here: aiCategory and topics are written by fileProfiler, this only reads them.
 *
 * A person's correction lives in FileContent.userClassification and always wins. Only
 * setUserClassification writes it; everything else here writes the automatic fields only.
 */

const CLASSIFIER_VERSION = 1;
const RULE_TEXT_CHARS = 15000; // what a document is shows near its start
const BATCH = 200;

const TAXONOMY = {
  Work: ['Resume', 'Cover Letter', 'Employment Document', 'Meeting Notes', 'Report', 'Contract', 'Project', 'Presentation', 'Certificate', 'Work Document'],
  School: ['Assignment', 'Notes', 'Exam / Quiz', 'Syllabus', 'Study Material', 'Transcript', 'Lecture Material', 'Certificate'],
  Financial: ['Bill', 'Invoice', 'Receipt', 'Bank Document', 'Tax Document', 'Pay Stub', 'Insurance'],
  Personal: ['ID / Personal Document', 'Travel', 'Personal Notes', 'Photo', 'Medical Document', 'Letter'],
  Other: ['Screenshot', 'Reference', 'Form', 'Spreadsheet / Data', 'Source Code', 'Unknown'],
};
const CATEGORIES = Object.keys(TAXONOMY);
const isValid = (category, type) => Boolean(TAXONOMY[category]?.includes(type));

// The background profile's categories (fileProfiler CATEGORIES), mapped onto the taxonomy.
const AI_CATEGORY_MAP = {
  'homework or assignment': ['School', 'Assignment'],
  'lecture or study notes': ['School', 'Notes'],
  'exam or quiz': ['School', 'Exam / Quiz'],
  'transcript or grades': ['School', 'Transcript'],
  'certificate or diploma': ['Work', 'Certificate'],
  'resume or cv': ['Work', 'Resume'],
  'cover letter': ['Work', 'Cover Letter'],
  bill: ['Financial', 'Bill'],
  invoice: ['Financial', 'Invoice'],
  receipt: ['Financial', 'Receipt'],
  'bank or card statement': ['Financial', 'Bank Document'],
  'tax document': ['Financial', 'Tax Document'],
  'pay stub': ['Financial', 'Pay Stub'],
  'contract or agreement': ['Work', 'Contract'],
  'letter or email': ['Personal', 'Letter'],
  report: ['Work', 'Report'],
  'work document': ['Work', 'Work Document'],
  'meeting notes': ['Work', 'Meeting Notes'],
  presentation: ['Work', 'Presentation'],
  'spreadsheet or data': ['Other', 'Spreadsheet / Data'],
  'form or application': ['Other', 'Form'],
  'id or personal document': ['Personal', 'ID / Personal Document'],
  'ticket or booking': ['Personal', 'Travel'],
  'medical document': ['Personal', 'Medical Document'],
  'insurance document': ['Financial', 'Insurance'],
  'manual or guide': ['Other', 'Reference'],
  'article or paper': ['Other', 'Reference'],
  'book or ebook': ['Other', 'Reference'],
  'source code': ['Other', 'Source Code'],
  'notes or list': ['Personal', 'Personal Notes'],
  other: ['Other', 'Unknown'],
};

/**
 * Keyword rules. Each matching name pattern or text signal counts once; `strongAt` signals (default 2)
 * make a strong rule. Signals are specific phrases so one stray word does not decide a file's type.
 */
const RULES = [
  { category: 'Financial', type: 'Invoice', name: /\binvoice|\binv[-_ ]?\d/i,
    signals: [/\binvoice\s*(?:#|no\b|number\b|date\b)/i, /\b(?:amount|balance|total) due\b/i, /\bbill(?:ed)? to\b/i, /\bpayment terms\b|\bnet ?30\b/i] },
  { category: 'Financial', type: 'Bill', name: /\bbill\b|\butility\b/i,
    signals: [/\b(?:amount|total) due\b|\bpayment due\b|\bpay by\b/i, /\bbilling (?:period|date|cycle)\b|\bservice period\b/i, /\bkwh\b|\b(?:electric(?:ity)?|water|gas|internet|wireless|phone) (?:bill|service|usage|charges)\b/i, /\baccount (?:number|no\b)/i] },
  { category: 'Financial', type: 'Receipt', name: /\breceipt/i,
    signals: [/\breceipt\b/i, /\bsub-?total\b/i, /\b(?:total|amount paid|paid)\b[^\n]{0,15}\d/i, /\b(?:visa|mastercard|amex|cash|change due|card ending)\b/i, /\bthank you for (?:your purchase|shopping|dining|visiting)\b/i] },
  { category: 'Financial', type: 'Bank Document', name: /\bbank|\bstatement\b/i,
    signals: [/\b(?:bank|checking|savings|card) (?:statement|account)\b/i, /\b(?:beginning|opening|ending|closing) balance\b/i, /\brouting number\b/i, /\bdeposits?\b[^\n]{0,40}\bwithdrawals?\b/i] },
  { category: 'Financial', type: 'Tax Document', name: /\btax|\bw-?2\b|\b1099\b|\b1040\b/i,
    signals: [/\bform (?:w-?2|w-?4|1099|1040)\b/i, /\binternal revenue service\b|\bIRS\b/, /\btax year\b/i, /\btaxable (?:income|wages)\b|\bincome tax withheld\b/i] },
  { category: 'Financial', type: 'Pay Stub', name: /\bpay ?stub|\bpayslip|\bpaycheck/i,
    signals: [/\bpay stub\b|\bearnings statement\b|\bpay period\b/i, /\b(?:gross|net) pay\b/i, /\bYTD\b|\byear to date\b/i] },
  { category: 'Financial', type: 'Insurance', name: /\binsurance|\bpolicy\b/i,
    signals: [/\bpolicy (?:number|no\b)/i, /\bpremium\b|\bdeductible\b/i, /\bpolicyholder\b|\binsured\b/i] },
  { category: 'School', type: 'Transcript', name: /\btranscript|\btsrpt\b/i,
    signals: [/\b(?:official|unofficial|academic) transcript\b/i, /\bGPA\b|\bgrade point average\b/i, /\b(?:credits?|units|hours) (?:attempted|earned)\b/i, /\bdean'?s list\b/i] },
  { category: 'School', type: 'Syllabus', name: /\bsyllabus/i,
    signals: [/\bsyllabus\b/i, /\boffice hours\b/i, /\bgrading (?:policy|breakdown|scale|criteria)\b/i, /\b(?:course|class) (?:schedule|description|objectives)\b/i, /\blearning (?:outcomes|objectives)\b/i] },
  { category: 'School', type: 'Assignment', name: /\b(?:hw|homework|assignment|pset|problem[ _-]?set)[ _-]?\d*\b/i,
    signals: [/\b(?:programming )?(?:assignment|homework|problem set|lab)\s*#?\d+\b/i, /\b(?:submit|submission|turn in|hand in)\b/i, /\(\s*\d+\s*(?:points?|pts)\s*\)|\b\d+\s*(?:points?|pts)\b/i, /\b(?:professor|instructor|prof\.)/i] },
  { category: 'School', type: 'Exam / Quiz', name: /\b(?:exam|quiz|midterm|final)\b/i,
    signals: [/\b(?:midterm|final) exam(?:ination)?\b|\bquiz\s*#?\d+\b/i, /\b(?:answer all|show (?:all )?your work|time allowed|closed book|open book)\b/i, /\bquestion\s*\d+\b[^\n]{0,30}\(?\d+\s*(?:points?|marks)/i] },
  { category: 'School', type: 'Notes', name: /\b(?:lecture|class)[ _-]?notes?\b|\blec[ _-]?\d+/i,
    signals: [/\blecture\s*\d+\b|\b(?:lecture|class) notes\b/i, /\btoday we (?:covered|discussed|learned|talked about)\b/i, /\b(?:midterm|exam|quiz|final) review\b/i] },
  { category: 'School', type: 'Lecture Material', name: /\bslides?\b|\blecture\b/i,
    signals: [/\blecture\s*\d+\b/i, /\bweek\s*\d+\b/i, /\b(?:learning objectives|in this lecture)\b/i] },
  { category: 'School', type: 'Certificate', name: /\bdiploma|\bdegree\b/i, strongAt: 2,
    signals: [/\b(?:certificate|diploma)\b/i, /\b(?:university|college|school of)\b/i, /\b(?:bachelor|master|doctor) of\b|\bdegree\b/i] },
  { category: 'Work', type: 'Certificate', name: /\bcertificat/i,
    signals: [/\bcertificat(?:e|ion)\b/i, /\b(?:aws|microsoft|google|cisco|comptia|credential id|completed the course)\b/i] },
  { category: 'Work', type: 'Resume', name: /\bresume\b|\brésumé\b|\bcv\b/i, strongAt: 3,
    signals: [/\b(?:work |professional )?experience\b/i, /\beducation\b/i, /\bskills\b/i, /\blinkedin\.com\b|\bgithub\.com\//i, /\b(?:objective|summary of qualifications|professional summary)\b/i] },
  { category: 'Work', type: 'Cover Letter', name: /\bcover[ _-]?letter/i,
    signals: [/\bdear (?:hiring manager|recruiter|sir or madam|search committee)\b/i, /\b(?:apply|applying) for the\b|\b(?:position|role) of\b/i, /\bcover letter\b/i, /\bthank you for (?:your time and )?consideration\b/i] },
  { category: 'Work', type: 'Employment Document', name: /\boffer[ _-]?letter|\bemployment\b/i,
    signals: [/\boffer letter\b|\bemployment (?:agreement|offer|verification|contract)\b/i, /\b(?:start date|annual salary|base salary|hourly rate)\b/i, /\bwe are (?:pleased|delighted) to offer\b/i] },
  { category: 'Work', type: 'Meeting Notes', name: /\bminutes\b|\bmeeting\b/i,
    signals: [/\bmeeting (?:notes|minutes)\b|\bminutes\b/i, /\b(?:attendees|agenda)\b/i, /\baction items?\b|\bdecisions?:/i] },
  { category: 'Work', type: 'Contract', name: /\bcontract|\bagreement\b|\bnda\b/i,
    signals: [/\bthis (?:agreement|contract)\b/i, /\bhereinafter\b|\bwhereas\b|\bthe parties\b/i, /\bgoverning law\b|\bindemnif|\btermination\b/i] },
  { category: 'Work', type: 'Report', name: /\breport\b/i,
    signals: [/\bexecutive summary\b/i, /\b(?:quarterly|annual|monthly|weekly|status|progress) report\b/i, /\b(?:findings|recommendations)\b/i] },
  { category: 'Personal', type: 'Travel', name: /\bitinerary|\bboarding|\bflight|\bbooking|\bticket|\btrip\b/i,
    signals: [/\bboarding pass\b|\bbooking (?:confirmation|reference)\b|\bitinerary\b|\be-?ticket\b|\breservation (?:number|code)\b/i, /\b(?:flight|departure|arrival|check-?in)\b/i, /\b[A-Z]{2}\s?\d{3,4}\b[^\n]{0,60}\b(?:to|from|departs?)\b/, /\bseat\s*\d{1,2}[A-K]\b|\bpassenger\b/i] },
  { category: 'Personal', type: 'Medical Document', name: /\bmedical|\blab[ _-]?results|\bprescription/i,
    signals: [/\bpatient\b/i, /\bdiagnosis\b|\bprescription\b|\bdosage\b/i, /\b(?:physician|clinic|hospital|dr\.)/i] },
  { category: 'Personal', type: 'ID / Personal Document', name: /\bpassport|\blicen[cs]e\b|\bbirth[ _-]?certificate|\bid[ _-]?card/i,
    signals: [/\bpassport\b|\bdriver'?s licen[cs]e\b|\bidentification (?:card|number)\b|\bbirth certificate\b/i, /\bdate of birth\b|\bDOB\b/, /\bsocial security\b|\bnationality\b/i] },
  { category: 'Other', type: 'Form', name: /\bform\b|\bapplication\b/i,
    signals: [/\bapplication form\b|\bplease (?:print|fill|complete)\b/i, /_{6,}/, /\bsignature of (?:applicant|parent|guardian)\b/i] },
];

const IMAGE = /^image\//i;
const SCREENSHOT_NAME = /screen ?shot|screen recording|capture/i;
const CODE_EXTENSIONS = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|java|c|h|cc|cpp|hpp|cs|go|rb|php|rs|swift|kt|scala|sql|sh|html?|css|scss|vue|svelte|r|lua|dart)$/i;
const SHEET_EXTENSIONS = /\.(?:xlsx?|ods|numbers|csv|tsv)$/i;

function ruleMatches(name, text) {
  return RULES.map((rule, order) => {
    let count = rule.name && rule.name.test(name) ? 1 : 0;
    for (const signal of rule.signals) if (signal.test(text)) count += 1;
    return { rule, order, count };
  }).filter(m => m.count > 0).sort((a, b) => b.count - a.count || a.order - b.order);
}

/** The format's own fallback (step 4). */
function formatDefault(file) {
  const name = file.originalName || '';
  if (IMAGE.test(file.mimeType || '')) return SCREENSHOT_NAME.test(name) ? ['Other', 'Screenshot'] : ['Personal', 'Photo'];
  if (CODE_EXTENSIONS.test(name)) return ['Other', 'Source Code'];
  if (SHEET_EXTENSIONS.test(name)) return ['Other', 'Spreadsheet / Data'];
  return ['Other', 'Unknown'];
}

/**
 * The automatic classification of one file, from what is already stored: its name and format, the
 * start of its extracted text, a picture's caption, and the profile's aiCategory. No disk, no AI.
 * Returns { primaryCategory, documentType, classificationSource: 'rules' | 'profile' | 'default' }.
 */
function classify(file, content = null) {
  const name = (file.originalName || '').replace(/[_]+/g, ' ');
  const text = `${(content?.extractedText || '').slice(0, RULE_TEXT_CHARS)}\n${file.aiCaption?.text || ''}`;
  const matches = ruleMatches(name, text);
  const best = matches[0];
  const result = (category, type, source) => ({ primaryCategory: category, documentType: type, classificationSource: source });

  if (best && best.count >= (best.rule.strongAt || 2)) return result(best.rule.category, best.rule.type, 'rules');
  const mapped = AI_CATEGORY_MAP[(content?.aiCategory || '').toLowerCase()];
  // "other" from the profile says nothing useful, so it does not stop a weak rule.
  if (mapped && !(mapped[0] === 'Other' && mapped[1] === 'Unknown')) return result(mapped[0], mapped[1], 'profile');
  if (best) return result(best.rule.category, best.rule.type, 'rules');
  const [category, type] = formatDefault(file);
  return result(category, type, 'default');
}

/**
 * The classification a person sees and search uses: their correction when there is one, otherwise the
 * stored automatic one, otherwise one worked out now (nothing saved).
 */
function effectiveClassification(file, content) {
  const topics = content?.topics || [];
  const user = content?.userClassification;
  if (user?.primaryCategory && isValid(user.primaryCategory, user.documentType)) {
    return { primaryCategory: user.primaryCategory, documentType: user.documentType, topics, source: 'user' };
  }
  if (content?.primaryCategory && isValid(content.primaryCategory, content.documentType)) {
    return { primaryCategory: content.primaryCategory, documentType: content.documentType, topics, source: content.classificationSource || 'rules' };
  }
  const auto = classify(file, content);
  return { primaryCategory: auto.primaryCategory, documentType: auto.documentType, topics, source: auto.classificationSource };
}

// Only the automatic fields. userClassification is never part of this update.
const automaticUpdate = (auto) => ({
  primaryCategory: auto.primaryCategory,
  documentType: auto.documentType,
  classificationSource: auto.classificationSource,
  classifiedAt: new Date(),
  classificationVersion: CLASSIFIER_VERSION,
});

/** Classify one file now (after its text is read or its profile is written). Never throws. */
async function classifyAndSave(fileId) {
  try {
    const [file, content] = await Promise.all([
      File.findById(fileId).select('originalName mimeType aiCaption').lean(),
      FileContent.findOne({ file: fileId }).select('extractedText aiCategory').lean(),
    ]);
    if (!file || !content) return null;
    const auto = classify(file, content);
    await FileContent.updateOne({ file: fileId }, { $set: automaticUpdate(auto) });
    return auto;
  } catch (error) {
    console.error('[Classify] Could not classify file:', error.message);
    return null;
  }
}

/**
 * One-time catch-up for files classified before this existed (or by an older rule set): no AI, in
 * batches, reading only the start of each text. Files with a correction keep it; their automatic
 * fields are filled in too, so Reset has something to fall back to. A second run finds nothing to do.
 */
async function catchUp() {
  let done = 0;
  let lastId = null;
  for (;;) {
    const contents = await FileContent.aggregate([
      { $match: { $and: [
        lastId ? { _id: { $gt: lastId } } : {},
        { $or: [{ classificationVersion: { $exists: false } }, { classificationVersion: { $lt: CLASSIFIER_VERSION } }] },
      ] } },
      { $sort: { _id: 1 } },
      { $limit: BATCH },
      { $project: { file: 1, aiCategory: 1, extractedText: { $substrCP: [{ $ifNull: ['$extractedText', ''] }, 0, RULE_TEXT_CHARS] } } },
    ]);
    if (!contents.length) break;
    lastId = contents[contents.length - 1]._id;
    const files = new Map((await File.find({ _id: { $in: contents.map(c => c.file) } }).select('originalName mimeType aiCaption').lean())
      .map(f => [f._id.toString(), f]));
    const ops = contents.filter(c => files.has(c.file.toString())).map(c => ({
      updateOne: { filter: { _id: c._id }, update: { $set: automaticUpdate(classify(files.get(c.file.toString()), c)) } },
    }));
    if (ops.length) await FileContent.bulkWrite(ops, { ordered: false });
    done += ops.length;
    if (contents.length < BATCH) break;
  }
  if (done) console.log(`[Classify] Classified ${done} older file${done === 1 ? '' : 's'} (no AI)`);
  return done;
}

/**
 * Save or remove a person's correction. The caller has already checked they are the owner or an editor.
 * `null` removes it, so the automatic classification shows again.
 */
async function setUserClassification(file, userId, correction) {
  if (!correction) {
    await FileContent.updateOne({ file: file._id }, { $unset: { userClassification: 1 } });
  } else {
    const textExtractor = require('./textExtractor');
    await FileContent.updateOne(
      { file: file._id },
      {
        $set: { userClassification: { primaryCategory: correction.primaryCategory, documentType: correction.documentType, by: userId, at: new Date() } },
        // A file File Box cannot read gets a record just to hold the correction.
        $setOnInsert: { file: file._id, extractionStatus: textExtractor.isSupported(file.mimeType) ? 'pending' : 'not_supported' },
      },
      { upsert: true }
    );
  }
  const content = await FileContent.findOne({ file: file._id }).select('extractedText aiCategory primaryCategory documentType classificationSource topics userClassification').lean();
  return effectiveClassification(file, content);
}

// ---- Search words for each type and category ("homework" means Assignment, "cv" means Resume)

const TYPE_WORDS = {
  Resume: ['resume', 'cv'], 'Cover Letter': ['cover'], 'Employment Document': ['employment', 'offer', 'job'],
  'Meeting Notes': ['meeting', 'minutes'], Report: ['report'], Contract: ['contract', 'agreement', 'nda'], Project: ['project'],
  Presentation: ['presentation', 'slides', 'deck'], Certificate: ['certificate', 'diploma', 'certification'], 'Work Document': [],
  Assignment: ['assignment', 'homework', 'hw', 'pset', 'lab'], Notes: ['notes', 'note'], 'Exam / Quiz': ['exam', 'quiz', 'midterm', 'test'],
  Syllabus: ['syllabus'], 'Study Material': ['study', 'textbook', 'material'], Transcript: ['transcript', 'grades'],
  'Lecture Material': ['lecture', 'slides'], Bill: ['bill'], Invoice: ['invoice'], Receipt: ['receipt'],
  'Bank Document': ['bank', 'statement'], 'Tax Document': ['tax', 'taxes', 'w2', '1099'], 'Pay Stub': ['paystub', 'payslip', 'paycheck'],
  Insurance: ['insurance', 'policy'], 'ID / Personal Document': ['passport', 'license', 'id'], Travel: ['travel', 'trip', 'flight', 'booking', 'ticket', 'itinerary'],
  'Personal Notes': ['notes', 'note', 'list'], Photo: ['photo', 'picture', 'pic'], 'Medical Document': ['medical', 'health'], Letter: ['letter'],
  Screenshot: ['screenshot'], Reference: ['reference', 'manual', 'guide', 'article', 'paper', 'book'], Form: ['form', 'application'],
  'Spreadsheet / Data': ['spreadsheet', 'data'], 'Source Code': ['code', 'script'], Unknown: [],
};
const CATEGORY_WORDS = { Work: ['work', 'job', 'career'], School: ['school', 'class', 'course', 'college', 'university'], Financial: ['financial', 'finance', 'money'], Personal: ['personal'], Other: [] };

module.exports = {
  TAXONOMY, CATEGORIES, AI_CATEGORY_MAP, RULES, TYPE_WORDS, CATEGORY_WORDS, CLASSIFIER_VERSION,
  isValid, classify, effectiveClassification, classifyAndSave, catchUp, setUserClassification,
};
