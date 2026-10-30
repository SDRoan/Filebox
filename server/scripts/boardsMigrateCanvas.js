/**
 * Boards: move tabs from the 12-column grid to the free canvas (pixels, zones) used by My Files > Board.
 *
 *   node scripts/boardsMigrateCanvas.js --backup             copy every grid tab to workspacetabs_backup_v1 and a JSON file
 *   node scripts/boardsMigrateCanvas.js --dry-run            show what would change; writes nothing
 *   node scripts/boardsMigrateCanvas.js --apply              migrate (only tabs whose exact backup exists and matches)
 *   node scripts/boardsMigrateCanvas.js --restore <tabId>    put a tab back exactly as backed up
 *
 * Only places change: ids, names, emoji, colour, order, default, block ids, file and folder references, note
 * words and the full text documents stay exactly as they are. The revision goes up by one, so a page still
 * open from before gets a conflict instead of saving grid positions.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { fromGrid } = require('../utils/boardLayout');

const BACKUP = 'workspacetabs_backup_v1';
const DIR = path.join(__dirname, '..', '..', '..', 'Filebox-backups', 'boards');
const canon = (doc) => JSON.stringify(doc, (key, value) => (value instanceof mongoose.Types.ObjectId ? `oid:${value}` : value instanceof Date ? `date:${value.toISOString()}` : value));
const content = (b) => { const { x, y, w, h, ...rest } = b; return rest; };

function migrated(tab) {
  const blocks = fromGrid(tab.blocks || []);
  const bytes = Buffer.byteLength(JSON.stringify({ name: tab.name, icon: tab.icon, color: tab.color, blocks, zones: [] }), 'utf8');
  return { blocks, zones: [], layoutVersion: 2, rev: tab.rev + 1, bytes };
}

/** Everything but the places is identical. */
function sameContent(before, after) {
  const a = before.blocks || [];
  const b = after.blocks;
  return a.length === b.length && a.every((block, i) => canon(content(block)) === canon(content(b[i])));
}

(async () => {
  const [mode, arg] = process.argv.slice(2);
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const tabs = db.collection('workspacetabs');
  const backup = db.collection(BACKUP);
  const grid = await tabs.find({ layoutVersion: { $ne: 2 } }).toArray();
  try {
    if (mode === '--backup') {
      fs.mkdirSync(DIR, { recursive: true });
      const file = path.join(DIR, `workspacetabs-v1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, canon(grid));
      for (const tab of grid) await backup.replaceOne({ _id: tab._id }, tab, { upsert: true });
      const check = await backup.find({ _id: { $in: grid.map(t => t._id) } }).toArray();
      const fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ok = grid.every(t => canon(check.find(c => String(c._id) === String(t._id))) === canon(t)) && canon(fromFile) === canon(JSON.parse(canon(grid)));
      console.log(`backed up ${grid.length} tab(s) to ${BACKUP} and ${file}; verified identical: ${ok}`);
      grid.forEach(t => console.log(`  ${t.tabId} "${t.name}" rev ${t.rev}, ${t.blocks.length} block(s): ${t.blocks.map(b => `${b.type}@${b.x},${b.y} ${b.w}x${b.h}`).join('; ')}`));
      if (!ok) process.exitCode = 1;
    } else if (mode === '--dry-run' || mode === '--apply') {
      for (const tab of grid) {
        const next = migrated(tab);
        const saved = await backup.findOne({ _id: tab._id });
        const backed = Boolean(saved) && canon(saved) === canon(tab);
        console.log(`${tab.tabId} "${tab.name}" rev ${tab.rev} → ${next.rev}; backup ${backed ? 'matches' : 'MISSING or different'}; content unchanged: ${sameContent(tab, next)}`);
        tab.blocks.forEach((b, i) => console.log(`  ${b.id} ${b.type}: grid ${b.x},${b.y} ${b.w}x${b.h} → px ${next.blocks[i].x},${next.blocks[i].y}${next.blocks[i].w !== undefined ? ` ${next.blocks[i].w}x${next.blocks[i].h}` : ''}`));
        if (mode !== '--apply') continue;
        if (!backed || !sameContent(tab, next)) { console.log('  skipped'); process.exitCode = 1; continue; }
        const res = await tabs.updateOne({ _id: tab._id, rev: tab.rev, layoutVersion: { $ne: 2 } }, { $set: { blocks: next.blocks, zones: next.zones, layoutVersion: 2, rev: next.rev, bytes: next.bytes } });
        console.log(`  ${res.modifiedCount ? 'migrated' : 'NOT migrated (changed meanwhile)'}`);
      }
      if (!grid.length) console.log('nothing to migrate');
    } else if (mode === '--restore') {
      const saved = await backup.findOne({ tabId: arg });
      if (!saved) throw new Error(`no backup for ${arg}`);
      await tabs.replaceOne({ _id: saved._id }, saved, { upsert: true });
      console.log(`restored ${arg} exactly as backed up (rev ${saved.rev})`);
    } else {
      console.log('use --backup, --dry-run, --apply or --restore <tabId>');
    }
  } finally {
    await mongoose.disconnect();
  }
})();
