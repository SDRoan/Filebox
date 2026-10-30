import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import ItemActions from './ItemActions';
import { BoardBlock, BoardNote, NoteColor, RichTextNode } from '../services/api';
import { RichTextView, isEmptyDoc } from '../utils/richTextRender';

/**
 * Sticky notes (plain text) and text areas (rich text) on a board's free canvas. Only the canvas grip moves
 * them; typing, selecting text or clicking inside never does. The text editor is loaded the first time it
 * is needed, and only the text area being edited has one; the others are drawn from their saved JSON.
 */

const RichTextEditor = lazy(() => import('./RichTextEditor'));

const NOTE_COLORS: Array<[NoteColor, string]> = [['yellow', 'Yellow'], ['pink', 'Pink'], ['blue', 'Blue'], ['green', 'Green'], ['purple', 'Purple'], ['orange', 'Orange']];
const TITLE_MAX = 80;
const BODY_MAX = 4000;

interface Common {
  phone: boolean;
  first: boolean;
  last: boolean;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onFlush: () => void;
  onExit: () => void;
}

const MoveItems: React.FC<Pick<Common, 'phone' | 'first' | 'last' | 'onMove'>> = ({ phone, first, last, onMove }) => (
  <>
    {phone && !first && <button type="button" onClick={() => onMove(-1)}>Move up</button>}
    {phone && !last && <button type="button" onClick={() => onMove(1)}>Move down</button>}
  </>
);

/** A sticky note: a title and a body, plain text, in one of six colours. */
export const StickyNoteBlock: React.FC<Common & { block: Extract<BoardBlock, { type: 'note' }>; onEdit: (note: BoardNote) => void }> = ({ block, onEdit, onFlush, onExit, onRemove, onMove, phone, first, last }) => {
  const [title, setTitle] = useState(block.note.title);
  const [body, setBody] = useState(block.note.body);
  const composing = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  // Follow the saved note (another device, a conflict, Undo) unless the person is typing in it.
  useEffect(() => {
    if (card.current?.contains(document.activeElement)) return;
    setTitle(block.note.title);
    setBody(block.note.body);
  }, [block.note.title, block.note.body]);

  const send = (next: Partial<BoardNote>) => onEdit({ title, body, color: block.note.color, ...next });
  const field = (setter: (v: string) => void, key: 'title' | 'body', max: number) => ({
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = Array.from(event.target.value).slice(0, max).join('');
      setter(value);
      // While a word is being composed (IME), wait for it; compositionend sends it.
      if (!composing.current) send({ [key]: value });
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false;
      const value = Array.from((event.target as HTMLInputElement).value).slice(0, max).join('');
      setter(value);
      send({ [key]: value });
    },
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onExit(); } },
  });

  return (
    <div ref={card} className={`board-note-card note-${block.note.color}`}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) onFlush(); }}>
      <div className="board-note-top">
        <span className="board-note-kind">Note</span>
        <ItemActions className="board-block-menu" label="Options for this note">
          <div className="board-note-colors" role="group" aria-label="Note color">
            {NOTE_COLORS.map(([value, name]) => (
              <button key={value} type="button" className={`board-note-swatch note-${value}`} aria-label={name} aria-pressed={block.note.color === value}
                onClick={() => { send({ color: value }); onFlush(); }} />
            ))}
          </div>
          <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
          <button type="button" onClick={onRemove}>Remove from board</button>
        </ItemActions>
      </div>
      <input className="board-note-title" value={title} maxLength={TITLE_MAX + 2} placeholder="Title" aria-label="Note title" {...field(setTitle, 'title', TITLE_MAX)} />
      <textarea className="board-note-body" value={body} placeholder="Write a note…" aria-label="Note" {...field(setBody, 'body', BODY_MAX)} />
      {Array.from(body).length > BODY_MAX - 200 && <p className="board-note-count">{Array.from(body).length}/{BODY_MAX}</p>}
    </div>
  );
};

/** A text area: rich text. Click (or Enter on the block) to edit; Escape stops editing. */
export const RichTextBlock: React.FC<Common & {
  block: Extract<BoardBlock, { type: 'text' }>;
  editing: boolean;
  saveState: string;
  onStartEdit: () => void;
  onEdit: (doc: RichTextNode) => void;
}> = ({ block, editing, saveState, onStartEdit, onEdit, onFlush, onExit, onRemove, onMove, phone, first, last }) => {
  const empty = isEmptyDoc(block.text.doc);
  const view = (
    <div className="rt-view" onClick={(event) => { if (!(event.target as HTMLElement).closest('a')) onStartEdit(); }}>
      {empty ? <p className="rt-empty">Click to write…</p> : <RichTextView doc={block.text.doc} />}
    </div>
  );
  return (
    <div className={`board-text-card ${editing ? 'is-editing' : ''}`}>
      <div className="board-note-top">
        <span className="board-note-kind">Text</span>
        {editing && <span className="board-text-status" aria-live="polite">{saveState === 'saving' ? 'Saving…' : saveState === 'waiting' ? 'Editing' : saveState === 'saved' ? 'Saved' : saveState === 'failed' ? 'Not saved' : ''}</span>}
        <ItemActions className="board-block-menu" label="Options for this text area">
          {!editing && <button type="button" onClick={onStartEdit}>Edit</button>}
          <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
          <button type="button" onClick={onRemove}>Remove from board</button>
        </ItemActions>
      </div>
      {editing ? (
        <Suspense fallback={view}>
          <RichTextEditor doc={block.text.doc} label="Text area" phone={phone} onChange={onEdit} onBlur={onFlush} onExit={onExit} />
        </Suspense>
      ) : view}
    </div>
  );
};
