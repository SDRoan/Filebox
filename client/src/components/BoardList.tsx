import React, { useRef } from 'react';
import { BoardBlock, BoardZone } from '../services/api';
import { StickyNoteBlock, RichTextBlock } from './BoardNoteBlocks';
import { BoardActions, TextFrame, blockName, hasOwnSize, ownSize, planningBlock, useRefCard } from './PersonalBoard';
import { CARD_WIDTH, Spot, zoneMembers } from '../utils/boardLayout';

/**
 * A personal board on a phone: the same items as the canvas, top to bottom, grouped under the zones they
 * sit in. Notes and text stay editable; Move up / Move down swaps an item's place with its neighbour.
 */

const placeOf = (b: BoardBlock): Spot => ({ x: b.x ?? 0, y: b.y ?? Number.MAX_SAFE_INTEGER });
const sizeOf = (b?: BoardBlock) => (b && hasOwnSize(b) ? ownSize(b) : { w: CARD_WIDTH, h: 200 });

const BoardList: React.FC<BoardActions & { blocks: BoardBlock[]; zones: BoardZone[]; saveState: string; editingId: string; empty: React.ReactNode }> = ({ blocks, zones, saveState, editingId, empty, ...actions }) => {
  const { onArrange, onEdit, onFlush, onRemove, onEditingChange } = actions;
  const refCard = useRefCard(actions);
  const editingRef = useRef(editingId);
  editingRef.current = editingId;
  const ordered = [...blocks].sort((a, b) => placeOf(a).y - placeOf(b).y || placeOf(a).x - placeOf(b).x || (a.id < b.id ? -1 : 1));
  const byId = new Map(blocks.map(b => [b.id, b]));
  const items = Object.fromEntries(blocks.map(b => [b.id, placeOf(b)]));
  const used = new Set<string>();
  const groups = zones.map((zone) => {
    const keys = zoneMembers(zone, ordered.map(b => b.id), items, id => sizeOf(byId.get(id))).filter(id => !used.has(id));
    keys.forEach(id => used.add(id));
    return { zone, list: ordered.filter(b => keys.includes(b.id)) };
  }).filter(g => g.list.length);
  const loose = ordered.filter(b => !used.has(b.id));

  // Move up / down: trade places with the neighbour in reading order.
  const move = (block: BoardBlock, direction: -1 | 1) => {
    const i = ordered.findIndex(b => b.id === block.id);
    const other = ordered[i + direction];
    if (!other) return;
    const a = placeOf(block);
    const b = placeOf(other);
    onArrange({ [block.id]: { x: b.x, y: b.y, w: block.w, h: block.h }, [other.id]: { x: a.x, y: a.y, w: other.w, h: other.h } });
    setTimeout(() => document.querySelector<HTMLElement>(`[data-list-id="${block.id}"]`)?.focus(), 50);
  };

  const row = (block: BoardBlock) => {
    const index = ordered.findIndex(b => b.id === block.id);
    const first = index === 0;
    const last = index === ordered.length - 1;
    const exit = () => { onFlush(); if (editingRef.current === block.id) onEditingChange(''); document.querySelector<HTMLElement>(`[data-list-id="${block.id}"]`)?.focus(); };
    let content: React.ReactNode;
    if (block.type === 'note') {
      content = <StickyNoteBlock block={block} phone first={first} last={last} onMove={(d) => move(block, d)} onEdit={(note) => onEdit(block.id, { note })} onFlush={onFlush} onExit={exit} onRemove={() => onRemove(block)} />;
    } else if (block.type === 'text') {
      content = (
        <TextFrame id={block.id} editingRef={editingRef} onEditingChange={onEditingChange}>
          <RichTextBlock block={block} editing={editingId === block.id} saveState={saveState} phone first={first} last={last} onMove={(d) => move(block, d)}
            onStartEdit={() => onEditingChange(block.id)} onEdit={(doc) => onEdit(block.id, { text: { doc } })} onFlush={onFlush} onExit={exit} onRemove={() => onRemove(block)} />
        </TextFrame>
      );
    } else if (block.type === 'checklist' || block.type === 'label' || block.type === 'deadline' || block.type === 'link') {
      content = planningBlock(block, actions, { phone: true, first, last, onMove: (d) => move(block, d), onExit: exit });
    } else {
      content = refCard(block, (
        <>
          {!first && <button className="icon-button" title="Move up" onClick={() => move(block, -1)}><span aria-hidden="true">↑</span></button>}
          {!last && <button className="icon-button" title="Move down" onClick={() => move(block, 1)}><span aria-hidden="true">↓</span></button>}
        </>
      ));
    }
    return (
      <li key={block.id} className={`board-list-row type-${block.type}`} data-list-id={block.id} tabIndex={-1} aria-label={`${blockName(block)}, ${index + 1} of ${ordered.length}`}>
        {content}
      </li>
    );
  };

  if (!blocks.length) return <div className="board-list-empty">{empty}</div>;
  return (
    <div className="board-list-phone">
      {groups.map(({ zone, list }) => (
        <section key={zone.id} className="board-list-zone" style={{ borderColor: zone.color, background: `${zone.color}55` }} aria-label={zone.name || 'Zone'}>
          <h3 className="board-list-zone-name">{zone.name || 'Zone'}</h3>
          <ol className="board-list file-list list-view">{list.map(row)}</ol>
        </section>
      ))}
      {loose.length > 0 && (
        <section className="board-list-zone is-loose" aria-label={groups.length ? 'Not in a zone' : 'Board items'}>
          {groups.length > 0 && <h3 className="board-list-zone-name">Not in a zone</h3>}
          <ol className="board-list file-list list-view">{loose.map(row)}</ol>
        </section>
      )}
    </div>
  );
};

export default BoardList;
