/**
 * Connectors on a Boards tab: a line or an arrow between two of the tab's items. Stored next to the blocks as
 * { id, fromId, toId, style } only (no positions: they are drawn from where their items are). The server is the
 * final authority: a connector is kept only if both of its items are on the tab being saved.
 */

const MAX_CONNECTORS = 300;
const ID = /^[a-z0-9]{10}$/;
const STYLES = ['line', 'arrow'];
const FIELDS = ['id', 'fromId', 'toId', 'style'];

class ConnectorError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** Which relationship a connector is: an arrow has a direction (A→B is not B→A); a line has none (A—B is B—A). */
const pairKey = (c) => (c.style === 'arrow' ? `arrow:${c.fromId}>${c.toId}` : `line:${[c.fromId, c.toId].sort().join('|')}`);

/**
 * The connectors a browser sent, checked against the blocks being saved. Anything malformed refuses the save;
 * a connector to an item not on the tab (removed, a zone, a stale page) and a second copy of a relationship are
 * dropped, so no dangling or repeated connector is ever stored.
 */
function cleanConnectors(raw, blockIds) {
  const bad = () => { throw new ConnectorError('These connectors could not be saved. Reload and try again.'); };
  if (!Array.isArray(raw)) bad();
  if (raw.length > MAX_CONNECTORS) throw new ConnectorError(`A tab can hold up to ${MAX_CONNECTORS} connectors.`);
  const ids = new Set();
  const pairs = new Set();
  const kept = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !FIELDS.includes(k))) bad();
    if (typeof c.id !== 'string' || !ID.test(c.id) || ids.has(c.id)) bad();
    ids.add(c.id);
    if (!STYLES.includes(c.style) || typeof c.fromId !== 'string' || typeof c.toId !== 'string' || c.fromId === c.toId) bad();
    if (!blockIds.has(c.fromId) || !blockIds.has(c.toId)) continue;
    const key = pairKey(c);
    if (pairs.has(key)) continue;
    pairs.add(key);
    kept.push({ id: c.id, fromId: c.fromId, toId: c.toId, style: c.style });
  }
  return kept;
}

/** Stored connectors kept only where both items still exist (when a save does not send connectors). */
const keepValid = (stored, blockIds) => {
  const pairs = new Set();
  return (Array.isArray(stored) ? stored : []).filter((c) => {
    if (!c || !blockIds.has(c.fromId) || !blockIds.has(c.toId) || pairs.has(pairKey(c))) return false;
    pairs.add(pairKey(c));
    return true;
  });
};

/** A copied tab's connectors: pointed at the copies' new ids, only where both items were copied. */
const remapConnectors = (stored, idMap, newId) => keepValid(stored, new Set(idMap.keys()))
  .map(c => ({ id: newId(), fromId: idMap.get(c.fromId), toId: idMap.get(c.toId), style: c.style }));

module.exports = { MAX_CONNECTORS, ConnectorError, pairKey, cleanConnectors, keepValid, remapConnectors };
