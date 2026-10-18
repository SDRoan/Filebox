#!/usr/bin/env node
/**
 * Turn 👎 corrections from File Box AI ("the right file was X") into test cases, so a mistake that was
 * corrected once is checked on every run: `node scripts/exportAiFeedback.js`, then `npm run test:ai -- --live`.
 *
 * Writes ai-accuracy/live-cases.json. It holds your own questions and file ids, so it is not committed.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const AIFeedback = require('../models/AIFeedback');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/filebox');
  const corrections = await AIFeedback.find({ rating: 'down', correctFile: { $ne: null } }).sort({ createdAt: 1 }).lean();
  const seen = new Set();
  const cases = [];
  for (const feedback of corrections) {
    const key = `${feedback.user}:${feedback.question.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const wrong = (feedback.shownFiles || []).find(id => !id.equals(feedback.correctFile));
    cases.push({
      userId: feedback.user.toString(),
      message: feedback.question,
      expectFileId: feedback.correctFile.toString(),
      notFileId: wrong ? wrong.toString() : undefined,
      note: feedback.note || undefined,
      from: feedback.createdAt,
    });
  }
  const out = path.join(__dirname, '..', 'ai-accuracy', 'live-cases.json');
  fs.writeFileSync(out, `${JSON.stringify({ about: 'Made from your File Box AI corrections. Not committed.', cases }, null, 2)}\n`);
  console.log(`Wrote ${cases.length} case${cases.length === 1 ? '' : 's'} from ${corrections.length} correction${corrections.length === 1 ? '' : 's'} to ${out}`);
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
