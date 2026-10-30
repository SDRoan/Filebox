import React, { useRef, useState } from 'react';
import ItemActions from './ItemActions';
import BoardDialog from './BoardDialog';
import { Common, MoveItems } from './BoardNoteBlocks';
import { BoardBlock, BoardLink } from '../services/api';
import { checkLink, domainOf, tileFor } from '../utils/boardLinks';

/**
 * A link on a board: a web address the person chose, an optional title and note, and a lettered tile made
 * from its domain. Nothing is fetched (no preview, no favicon); the link opens only in a new browser tab,
 * with no way back into File Box and no referrer.
 */

const LIMIT = { title: 200, note: 500 };
const clip = (value: string, max: number) => Array.from(value).slice(0, max).join('');
const count = (value: string) => Array.from(value).length;

/** Add or edit a link. The address is checked (and a domain given https://) before anything is saved. */
export const LinkDialog: React.FC<{ initial?: BoardLink; onSave: (link: BoardLink) => void; onClose: () => void }> = ({ initial, onSave, onClose }) => {
  const [url, setUrl] = useState(initial?.url || '');
  const [title, setTitle] = useState(initial?.title || '');
  const [note, setNote] = useState(initial?.note || '');
  const [tried, setTried] = useState(false);
  const checked = checkLink(url);
  const showError = (tried || Boolean(initial)) && !checked.ok;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!checked.ok) return;
    onSave({ url: checked.url, title: title.trim(), note });
  };
  return (
    <BoardDialog title={initial ? 'Edit link' : 'Add a link'} wide onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <label className="boards-field">
          <span>Web address</span>
          <input value={url} onChange={e => setUrl(e.target.value)} inputMode="url" autoComplete="off" spellCheck={false} autoCapitalize="none"
            placeholder="example.com or https://…" aria-invalid={showError} aria-describedby="board-link-check" data-autofocus />
        </label>
        <p id="board-link-check" className={showError ? 'boards-dialog-error' : 'boards-field-help is-left'} role={showError ? 'alert' : undefined} aria-live="polite">
          {showError && !checked.ok ? checked.error : checked.ok ? `Will open: ${checked.url}` : 'Opens in a new tab. Nothing is downloaded from it.'}
        </p>
        <label className="boards-field">
          <span>Title (optional)</span>
          <input value={title} onChange={e => setTitle(clip(e.target.value, LIMIT.title))} maxLength={LIMIT.title + 2} aria-describedby="board-link-title-count" placeholder={checked.ok ? domainOf(checked.url) : ''} />
        </label>
        <p id="board-link-title-count" className="boards-field-help">{count(title)}/{LIMIT.title}</p>
        <label className="boards-field">
          <span>Note (optional)</span>
          <textarea className="board-link-note-field" value={note} onChange={e => setNote(clip(e.target.value, LIMIT.note))} rows={3} aria-describedby="board-link-note-count" />
        </label>
        <p id="board-link-note-count" className="boards-field-help">{count(note)}/{LIMIT.note}</p>
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="boards-button-primary">{initial ? 'Save' : 'Add link'}</button>
        </div>
      </form>
    </BoardDialog>
  );
};

export const LinkBlock: React.FC<Common & { block: Extract<BoardBlock, { type: 'link' }>; onEdit: (link: BoardLink) => void }> = ({ block, onEdit, onExit, onRemove, onMove, phone, first, last }) => {
  const [editing, setEditing] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const { url, title, note } = block.link;
  const domain = domainOf(url);
  const tile = tileFor(url);
  const name = title || domain;
  return (
    <div className="board-link-card">
      <div className="board-note-top">
        <span className="board-note-kind">Link</span>
        <ItemActions className="board-block-menu" label={`Options for link ${name}`}>
          <button type="button" onClick={() => setEditing(true)}>Edit link…</button>
          <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
          <button type="button" onClick={onRemove}>Remove from board</button>
        </ItemActions>
      </div>
      <div className="board-link-main">
        <span className={`board-link-tile ${tile.globe ? 'is-globe' : ''}`} style={{ background: tile.color }} aria-hidden="true">{tile.letter}</span>
        <div className="board-link-text">
          <a ref={anchor} className="board-link-title" href={url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={url}
            aria-label={`Open ${title ? `${title} (${domain})` : domain}, opens in a new tab`}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onExit(); } }}>
            {name}
          </a>
          <span className="board-link-domain">{title ? domain : url}</span>
        </div>
      </div>
      {note && <p className="board-link-note">{note}</p>}
      {editing && (
        <LinkDialog initial={block.link} onClose={() => setEditing(false)}
          onSave={(next) => { setEditing(false); onEdit(next); setTimeout(() => anchor.current?.focus(), 50); }} />
      )}
    </div>
  );
};
