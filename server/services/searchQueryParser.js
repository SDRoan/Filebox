const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { TAXONOMY } = require('./fileClassifier');

/**
 * Turns a search written in plain words ("invoices from September", "work PDFs mentioning React") into
 * Advanced Search filters. Rules first; nothing here reads files or decides access.
 *
 * parseQuery(text, { now, tz, hasFolderFocus }) → {
 *   filters: { category, documentType, format, date, from, to, dateField, location, sort },  (only what was said)
 *   text,          the words to look for inside files ('' when the request was only filters)
 *   understood,    readable pieces for the page's "Understood as" pills: [{ key, label }]
 *   contentCue,    true for "mentions / contains / about / said / wrote" or quoted words
 *   confidence,    'high', or 'low' when a time was said that the rules cannot place ("last spring")
 *   vague,         the words that made it low
 * }
 * parseWithModel(text, …) asks the local model once, only for a low-confidence request, and keeps the
 * answer for 10 minutes. It is used by the Advanced Search page after Enter, never while typing.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALIASES = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_WORD = `(${[...MONTHS, ...Object.keys(MONTH_ALIASES)].join('|')})\\.?`;
const monthIndex = (word) => (MONTHS.includes(word) ? MONTHS.indexOf(word) : MONTH_ALIASES[word]);

// Document types, most specific first. Bare "notes" is left out on purpose: it could be class notes,
// meeting notes or personal notes, so it stays a search word.
const TYPE_PHRASES = [
  ['class notes|lecture notes|study notes|course notes', 'School', 'Notes'],
  ['meeting notes|meeting minutes|minutes', 'Work', 'Meeting Notes'],
  ['study guides?|study materials?|textbooks?', 'School', 'Study Material'],
  ['lecture slides', 'School', 'Lecture Material'],
  ['problem sets?|psets?|lab reports?|homeworks?|assignments?|hw', 'School', 'Assignment'],
  ['midterms?|exams?|quiz(?:zes)?', 'School', 'Exam / Quiz'],
  ['syllabus|syllabi', 'School', 'Syllabus'],
  ['transcripts?|grade reports?', 'School', 'Transcript'],
  ['cover letters?', 'Work', 'Cover Letter'],
  ['offer letters?|employment (?:letters?|documents?|contracts?)', 'Work', 'Employment Document'],
  ['résumés?|resumes?|cvs?', 'Work', 'Resume'],
  ['contracts?|agreements?|ndas?', 'Work', 'Contract'],
  ['presentations?|slide decks?|decks?', 'Work', 'Presentation'],
  ['reports?', 'Work', 'Report'],
  ['certificates?|certifications?|diplomas?', '', 'Certificate'],
  ['utility bills?|bills?', 'Financial', 'Bill'],
  ['invoices?', 'Financial', 'Invoice'],
  ['receipts?', 'Financial', 'Receipt'],
  ['bank statements?|card statements?|statements?', 'Financial', 'Bank Document'],
  ['tax (?:forms?|documents?|returns?)|w-?2s?|1099s?', 'Financial', 'Tax Document'],
  ['pay ?stubs?|payslips?|paychecks?', 'Financial', 'Pay Stub'],
  ['insurance (?:documents?|policies|policy|cards?)', 'Financial', 'Insurance'],
  ['passports?|id cards?|driver\'?s licen[cs]es?', 'Personal', 'ID / Personal Document'],
  ['boarding pass(?:es)?|itinerar(?:y|ies)|e-?tickets?|tickets?|flight bookings?|bookings?|travel documents?', 'Personal', 'Travel'],
  ['medical (?:records?|documents?)|prescriptions?|lab results?', 'Personal', 'Medical Document'],
  ['letters?', 'Personal', 'Letter'],
  ['screenshots?|screen shots?', 'Other', 'Screenshot'],
  ['forms?|applications?', 'Other', 'Form'],
];
const CATEGORY_PHRASES = [
  ['school|class|course|college|university|uni', 'School'],
  ['work|job|office', 'Work'],
  ['financial|finance|finances|money', 'Financial'],
  ['personal', 'Personal'],
];
const FORMAT_PHRASES = [
  ['pdfs?', 'pdf', 'PDF'],
  ['images?|photos?|pictures?|pics?', 'image', 'Image'],
  ['word (?:docs?|documents?|files?)|docx|spreadsheets?|excel (?:files?|sheets?)|slideshows?', 'document', 'Document'],
  ['code(?: files?)?|source(?: code| files?)|scripts?', 'code', 'Code'],
  ['text files?|txt files?|plain text', 'text', 'Text'],
];
const FILLER = new Set(('find show me search for look locate get give list do i have has where is are was were my all the a an any some '
  + 'files file documents document docs doc please can could you that which with of from in on to and or every stuff things thing '
  + 'there those these one ones what kind type about by also just only like but it they we everything anything').split(' '));
const VAGUE_TIME = /\b(?:last|this|next)\s+(?:spring|summer|fall|autumn|winter|semester|term|quarter)\b|\b(?:spring|summer|fall|autumn|winter)\s+(?:semester|term|break)\b|\b(?:around|near|before|after)\s+(?:christmas|thanksgiving|easter|new year'?s?|the holidays)\b|\b(?:christmas|thanksgiving|easter)\b|\ba while (?:ago|back)\b|\bthe other day\b|\b(?:a )?(?:few|couple(?: of)?|several) (?:days|weeks|months|years) (?:ago|back)\b|\b\d+ (?:days?|weeks?|months?|years?) ago\b/i;
// Words that say what to look for inside a file; everything after them is the search text.
const CONTENT_CUE = /\b(?:(?:that|which|where|when)\s+)?(?:(?:i|it|they|we)\s+)?(?:mention(?:s|ed|ing)?|contain(?:s|ed|ing)?|say(?:s|ing)?|said|wrote|written|write about|talk(?:s|ed|ing)? about|refer(?:s|red|ring)? to|with the words?|about|regarding|related to|on the (?:topic|subject) of)\b\s*/i;

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Today in the person's time zone (tz is the browser's getTimezoneOffset()). */
function localToday(now, tz) {
  const local = new Date(now.getTime() - (Number(tz) || 0) * 60000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), dow: local.getUTCDay() };
}
const shift = ({ y, m, d }, days) => {
  const t = new Date(Date.UTC(y, m, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
};
const iso = (p) => isoDay(p.y, p.m, p.d);
const monthLabel = (y, m) => `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${y}`;

/** A date range is only kept when it is real, ordered and within sensible years. */
function validRange(from, to) {
  const ok = (s) => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);
  if (!ok(from) || !ok(to) || (!from && !to)) return false;
  if (from && to && from > to) return false;
  const year = (s) => Number(s.slice(0, 4));
  return [from, to].filter(Boolean).every(s => year(s) >= 1970 && year(s) <= 2100);
}

/**
 * Dates said in words. Returns { date, from, to, label } or null. A month without a year is its most
 * recent occurrence (September asked in October 2026 means September 2026; in March 2027 too).
 */
function readDate(s, today, { strict = false } = {}) {
  const t = s.toLowerCase();
  let m;
  // After the search words, only phrases that clearly are dates count ("from September", "this week").
  if (strict && !/\b(?:today|yesterday|this\s+(?:week|month|year)|(?:last|past)\s+\w+|since|before|in|from|during)\b/.test(t)) return null;
  if ((m = t.match(/\btoday\b/))) return { match: m[0], date: 'today', label: 'today' };
  if ((m = t.match(/\byesterday\b/))) { const y = shift(today, -1); return { match: m[0], date: 'custom', from: iso(y), to: iso(y), label: 'yesterday' }; }
  if ((m = t.match(/\bthis\s+(week|month|year)\b/))) return { match: m[0], date: m[1], label: `this ${m[1]}` };
  if ((m = t.match(/\b(?:in\s+the\s+)?(?:last|past)\s+(\d{1,4})\s+days?\b/))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 3650) return { match: m[0], date: 'custom', from: iso(shift(today, -(n - 1))), to: iso(today), label: `in the last ${n} days` };
  }
  if ((m = t.match(/\blast\s+week\b/))) {
    const start = shift(today, -today.dow - 7);
    return { match: m[0], date: 'custom', from: iso(start), to: iso(shift(start, 6)), label: 'last week' };
  }
  if ((m = t.match(/\blast\s+month\b/))) {
    const y = today.m === 0 ? today.y - 1 : today.y;
    const mo = (today.m + 11) % 12;
    return { match: m[0], date: 'custom', from: isoDay(y, mo, 1), to: isoDay(y, mo, daysIn(y, mo)), label: `in ${monthLabel(y, mo)}` };
  }
  if ((m = t.match(/\blast\s+year\b/))) return { match: m[0], date: 'custom', from: `${today.y - 1}-01-01`, to: `${today.y - 1}-12-31`, label: `in ${today.y - 1}` };
  // since / before a month, a day or a year
  const point = `(?:${MONTH_WORD}(?:\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?|(\\d{4})-(\\d{2})-(\\d{2})|(\\d{4}))`;
  const pointValue = (g, end) => {
    if (g[0] && monthIndex(g[0]) !== undefined) {
      const mo = monthIndex(g[0]);
      const y = g[2] ? Number(g[2]) : (mo <= today.m ? today.y : today.y - 1);
      const d = g[1] ? Number(g[1]) : (end ? daysIn(y, mo) : 1);
      return d >= 1 && d <= daysIn(y, mo) ? isoDay(y, mo, d) : null;
    }
    if (g[3]) return `${g[3]}-${g[4]}-${g[5]}`;
    if (g[6]) return end ? `${g[6]}-12-31` : `${g[6]}-01-01`;
    return null;
  };
  if ((m = t.match(new RegExp(`\\bsince\\s+${point}`)))) {
    const from = pointValue(m.slice(1), false);
    if (from && validRange(from, null)) return { match: m[0], date: 'custom', from, to: '', label: `since ${from}` };
  }
  if ((m = t.match(new RegExp(`\\bbefore\\s+${point}`)))) {
    const at = pointValue(m.slice(1), false);
    if (at) {
      const p = new Date(`${at}T00:00:00Z`);
      const to = new Date(p.getTime() - 86400000).toISOString().slice(0, 10);
      if (validRange(null, to)) return { match: m[0], date: 'custom', from: '', to, label: `before ${at}` };
    }
  }
  // A month (with or without a year). "May" needs "in/from/during" or a year, since it is also a word.
  const monthRe = new RegExp(`\\b(?:(in|from|during|for|of)\\s+)?${MONTH_WORD}(?:\\s+(\\d{4}))?\\b`);
  if ((m = t.match(monthRe)) && (m[2] !== 'may' || m[1] || m[3]) && (!strict || m[1])) {
    const mo = monthIndex(m[2]);
    const y = m[3] ? Number(m[3]) : (mo <= today.m ? today.y : today.y - 1);
    return { match: m[0], date: 'custom', from: isoDay(y, mo, 1), to: isoDay(y, mo, daysIn(y, mo)), label: `in ${monthLabel(y, mo)}` };
  }
  if ((m = t.match(/\b(?:in|from|during|for)\s+((?:19|20)\d{2})\b/))) {
    return { match: m[0], date: 'custom', from: `${m[1]}-01-01`, to: `${m[1]}-12-31`, label: `in ${m[1]}` };
  }
  return null;
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (text) => text.split(/[^A-Za-z0-9$#&@.'\-/]+/)
  .map(w => w.replace(/^[.'-]+|[.'-]+$/g, ''))
  .filter(w => w && !FILLER.has(w.toLowerCase()))
  .join(' ');
// Not part of a file name: "budget.pdf" is a name to look up, not the PDF format.
const phraseRe = (alternatives) => new RegExp(`(?<![a-z0-9.])(?:${alternatives})(?![a-z0-9])`, 'i');
const blank = (s, match) => s.replace(match, ' '.repeat(match.length));

function parseQuery(input, { now = new Date(), tz = 0, hasFolderFocus = false } = {}) {
  const original = String(input || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const filters = {};
  const understood = [];
  let contentCue = false;
  const textParts = [];
  let s = original;

  // Quoted words are searched as they are.
  const quoted = [...s.matchAll(/["“]([^"”]{1,120})["”]/g)].map(q => q[1].trim()).filter(Boolean);
  if (quoted.length) {
    contentCue = true;
    textParts.push(...quoted);
    s = s.replace(/["“][^"”]{1,120}["”]/g, ' ');
  }

  const vagueMatch = s.match(VAGUE_TIME);
  const vague = vagueMatch ? vagueMatch[0] : '';
  if (vague) s = blank(s, vague);

  // Split at "mentions / contains / about / said / wrote": what follows is what to look for inside files.
  let before = s;
  let after = '';
  const cue = s.match(CONTENT_CUE);
  if (cue && s.slice(cue.index + cue[0].length).trim()) {
    before = s.slice(0, cue.index);
    after = s.slice(cue.index + cue[0].length).replace(/^\s*(?:the\s+words?\s+)?(?:(?:a|an|the|my|some|any)\s+)?/i, '');
  } else if (cue && quoted.length) {
    // "the invoice that says “amount due”": the quote was the search words; the cue itself is not.
    before = blank(s, cue[0]);
  }

  // When. After the search words only with a date word ("about semaphores from last week"), so
  // "files that mention September" searches for the word.
  const today = localToday(now, tz);
  let when = null;
  if (!vague) {
    when = readDate(before, today);
    if (when) before = before.replace(new RegExp(escape(when.match), 'i'), ' ');
    else {
      when = readDate(after, today, { strict: true });
      if (when) after = after.replace(new RegExp(escape(when.match), 'i'), ' ');
    }
  }
  if (when) Object.assign(filters, { date: when.date, ...(when.from ? { from: when.from } : {}), ...(when.to ? { to: when.to } : {}) });
  const uploadedWord = before.match(/\b(?:uploaded|added|saved)\b/i);
  if (filters.date && uploadedWord) { filters.dateField = 'uploaded'; before = blank(before, uploadedWord[0]); }
  before = before.replace(/\b(?:modified|changed|edited|updated)\b/gi, ' ');
  if (when) understood.push({ key: 'date', label: `${filters.dateField === 'uploaded' ? 'Uploaded' : 'Modified'} ${when.label}` });

  // Where and in which order (from either part).
  const take = (re) => {
    for (const part of ['before', 'after']) {
      const text = part === 'before' ? before : after;
      const hit = text.match(re);
      if (hit) {
        if (part === 'before') before = blank(before, hit[0]); else after = blank(after, hit[0]);
        return hit;
      }
    }
    return null;
  };
  if (take(/\b(?:that\s+(?:were|was|are|is)\s+|people\s+|others\s+|someone\s+)?shared\s+with\s+me\b|\bshared\s+files\b/i)) {
    filters.location = 'shared'; understood.push({ key: 'location', label: 'Shared with me' });
  } else if (take(/\b(?:in|from)\s+(?:my\s+|the\s+|our\s+)?team\s*spaces?\b|\bteam\s+(?:space\s+)?files\b|\bfrom\s+my\s+team\b/i)) {
    filters.location = 'team'; understood.push({ key: 'location', label: 'Team Spaces' });
  } else if (take(/\bin\s+my\s+files\b/i)) {
    filters.location = 'my-files'; understood.push({ key: 'location', label: 'My Files' });
  } else if (take(/\b(?:in\s+)?this\s+folder\b|\bin\s+here\b|\bhere\b/i) && hasFolderFocus) {
    filters.location = 'folder'; understood.push({ key: 'location', label: 'This folder' });
  }
  if (take(/\b(?:newest|latest|most\s+recent(?:ly\s+(?:changed|modified))?|recent)\b/i)) {
    filters.sort = 'modified'; understood.push({ key: 'sort', label: 'Recently modified' });
  } else if (take(/\boldest\b/i)) {
    filters.sort = 'oldest'; understood.push({ key: 'sort', label: 'Oldest first' });
  }

  // Kind of document, category and format, from the part before the search words.
  for (const [alternatives, category, type] of TYPE_PHRASES) {
    const hit = before.match(phraseRe(alternatives));
    if (hit) {
      filters.documentType = type;
      if (category) filters.category = category;
      before = blank(before, hit[0]);
      break;
    }
  }
  for (const [alternatives, category] of CATEGORY_PHRASES) {
    const hit = before.match(phraseRe(alternatives));
    if (hit) {
      if (!filters.category) filters.category = category;
      before = blank(before, hit[0]);
      break;
    }
  }
  if (filters.documentType && filters.category && !TAXONOMY[filters.category]?.includes(filters.documentType)) delete filters.category;
  for (const [alternatives, format, label] of FORMAT_PHRASES) {
    const hit = before.match(phraseRe(alternatives));
    if (hit) { filters.format = format; understood.push({ key: 'format', label }); before = blank(before, hit[0]); break; }
  }
  if (filters.documentType) understood.unshift({ key: 'documentType', label: filters.documentType });
  if (filters.category) understood.unshift({ key: 'category', label: filters.category });

  // Words left before the cue (bare "notes", a name, a number) are searched for too; filler is dropped.
  const leftover = words(before.replace(/^\s*(?:i\s+(?:don'?t|do\s+not|can'?t)\s+remember\b.*?(?:,|\bbut\b)\s*)/i, ' '));
  // A date word left behind by a removed date ("about semaphores from last week").
  const afterWords = after.replace(/[?!.,;:]+\s*$/g, '').replace(/\s+/g, ' ').trim().replace(/\s+(?:from|in|during|on|of|for|since|before)$/i, '');
  if (afterWords) contentCue = true;
  const text = [leftover, ...textParts, afterWords].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (text) understood.push({ key: 'text', label: `“${text}”` });

  return { filters, text, understood, contentCue, confidence: vague ? 'low' : 'high', vague };
}

// ---- One model parse for a low-confidence request (Advanced Search page, after Enter)

const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

async function parseWithModel(input, { now = new Date(), tz = 0, hasFolderFocus = false } = {}) {
  const rules = parseQuery(input, { now, tz, hasFolderFocus });
  if (rules.confidence === 'high' || !rules.vague) return { ...rules, usedModel: false };
  const today = localToday(now, tz);
  const key = `${iso(today)}|${hasFolderFocus}|${rules.vague.toLowerCase()}`;
  const hit = cache.get(key);
  const finish = (range, cached) => {
    // The model only places the time the rules could not; kind, category, format and words stay the rules'.
    if (!range) return { ...rules, usedModel: true, cached, modelDate: null };
    const label = range.from && range.to ? `Modified ${range.from} to ${range.to}` : range.from ? `Modified since ${range.from}` : `Modified until ${range.to}`;
    const understood = [...rules.understood.filter(u => u.key !== 'text'), { key: 'date', label }, ...rules.understood.filter(u => u.key === 'text')];
    return {
      ...rules,
      filters: { ...rules.filters, date: 'custom', ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) },
      understood,
      confidence: 'model',
      usedModel: true,
      cached,
      modelDate: range,
    };
  };
  if (hit && Date.now() - hit.at < CACHE_MS) return finish(hit.range, true);

  let range = null;
  try {
    const raw = await ollamaClient.chat({
      task: 'plan',
      model: config.ollama.understandingModel,
      system: `You turn a time phrase from a file search into a date range. Today is ${iso(today)}. Return JSON with "from" and "to" as YYYY-MM-DD, both inclusive.
Seasons: spring is March 1 to May 31, summer June 1 to August 31, fall September 1 to November 30, winter December 1 to the end of February.
"last" means the most recent one that has already ended; "this" means the current one. Holidays: the week around the holiday. If the phrase cannot be placed, return "" for both.`,
      content: rules.vague,
      format: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    });
    const parsed = JSON.parse(raw);
    const from = String(parsed?.from || '').trim();
    const to = String(parsed?.to || '').trim();
    // Only a real, ordered range that is not in the future is used; anything else is left unplaced.
    if (from && to && validRange(from, to) && from <= iso(today)) range = { from, to };
  } catch (error) {
    // The rules' reading still stands; nothing is cached, so a later Enter can try again.
    console.error('[Search parse] Model parse failed:', error.message);
    return { ...rules, usedModel: false, modelFailed: true };
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), range });
  return finish(range, false);
}

module.exports = { parseQuery, parseWithModel, validRange };
