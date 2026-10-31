import React, { useEffect, useRef, useState } from 'react';
import ItemActions from './ItemActions';
import { Common, MoveItems } from './BoardNoteBlocks';
import { BoardBlock, BoardDeadline, BoardLabel, LabelSize, LabelTone } from '../services/api';

/**
 * Board-only planning blocks: a label (a plain heading for an area of the board) and a deadline. Like
 * sticky notes they move only by the canvas grip; typing or picking a date never moves them. Changes go
 * through the board's one save engine: typing is saved after a pause, Complete or a date straight away.
 * (Checklists live in text areas.)
 */

type Edit<T> = (content: T, now?: boolean) => void;
const LIMIT = { label: 120, deadlineTitle: 120, deadlineNote: 500 };
const clip = (value: string, max: number) => Array.from(value).slice(0, max).join('');

/** Follow the saved content (another device, a conflict, Undo) unless the person is working in this block. */
function useSaved<T>(saved: T, card: React.RefObject<HTMLElement | null>) {
  const [value, setValue] = useState(saved);
  const key = JSON.stringify(saved);
  useEffect(() => {
    if (card.current?.contains(document.activeElement)) return;
    setValue(saved);
    // `key` stands for the saved content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [value, setValue] as const;
}

/** Saves when focus leaves the block (unless it moves into one of its own menus). */
const leaveSaves = (onFlush: () => void) => (event: React.FocusEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) onFlush(); };

// ---- Label

export const LABEL_TONES: Array<[LabelTone, string]> = [['default', 'Default'], ['sage', 'Sage'], ['sky', 'Sky'], ['rose', 'Rose'], ['amber', 'Amber'], ['slate', 'Slate']];
const SIZES: Array<[LabelSize, string]> = [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']];
const ALIGNS: Array<[BoardLabel['align'], string]> = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];

export const LabelBlock: React.FC<Common & { block: Extract<BoardBlock, { type: 'label' }>; onEdit: Edit<BoardLabel> }> = ({ block, onEdit, onFlush, onExit, onRemove, onMove, phone, first, last }) => {
  const card = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useSaved(block.label, card);
  const composing = useRef(false);
  const send = (next: BoardLabel, now = false) => { setLabel(next); if (!composing.current || now) onEdit(next, now); };
  return (
    <div ref={card} className={`board-label size-${label.size} align-${label.align} tone-${label.tone}`} onBlur={leaveSaves(onFlush)}>
      <input className="board-label-text" value={label.text} placeholder="Label" aria-label="Label text" maxLength={LIMIT.label + 2}
        onChange={e => send({ ...label, text: clip(e.target.value, LIMIT.label) })}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; send({ ...label, text: clip((e.target as HTMLInputElement).value, LIMIT.label) }); }}
        onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) { e.preventDefault(); onExit(); } }} />
      <ItemActions className="board-block-menu board-label-menu" label="Options for this label">
        <div className="board-label-options" role="group" aria-label="Heading size">
          {SIZES.map(([value, name]) => <button key={value} type="button" aria-pressed={label.size === value} onClick={() => send({ ...label, size: value }, true)}>{name}</button>)}
        </div>
        <div className="board-label-options" role="group" aria-label="Alignment">
          {ALIGNS.map(([value, name]) => <button key={value} type="button" aria-pressed={label.align === value} onClick={() => send({ ...label, align: value }, true)}>{name}</button>)}
        </div>
        <div className="board-label-tones" role="group" aria-label="Color">
          {LABEL_TONES.map(([value, name]) => (
            <button key={value} type="button" className={`board-label-tone tone-${value}`} aria-label={name} aria-pressed={label.tone === value} title={name} onClick={() => send({ ...label, tone: value }, true)}>A</button>
          ))}
        </div>
        <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
        <button type="button" onClick={onRemove}>Remove from board</button>
      </ItemActions>
    </div>
  );
};

// ---- Deadline

// One timer for the whole board: every deadline on screen re-reads the time once a minute.
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    clockListeners.add(tick);
    if (!clockTimer) clockTimer = setInterval(() => clockListeners.forEach(fn => fn()), 60000);
    return () => {
      clockListeners.delete(tick);
      if (!clockListeners.size && clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    };
  }, []);
  return now;
}
export const clockListenerCount = () => clockListeners.size;

const localDay = (date: string) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d); };
const dayKey = (t: Date) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;

export type DeadlineStatus = 'completed' | 'overdue' | 'today' | 'upcoming' | 'none';

/**
 * The deadline's status now. A date-only deadline is due at the end of that calendar day where it is viewed;
 * a timed one at its exact moment (shown in local time), so time zones and daylight saving come out right.
 */
export function deadlineStatus(deadline: BoardDeadline, now: number): DeadlineStatus {
  if (deadline.completedAt) return 'completed';
  if (!deadline.due) return 'none';
  const dueAt = deadline.due.time && deadline.due.at ? new Date(deadline.due.at) : new Date(localDay(deadline.due.date).getTime() + 86400000 - 1);
  if (now > dueAt.getTime()) return 'overdue';
  const dueDay = deadline.due.time && deadline.due.at ? dayKey(dueAt) : deadline.due.date;
  return dueDay === dayKey(new Date(now)) ? 'today' : 'upcoming';
}

const dueText = (deadline: BoardDeadline) => {
  if (!deadline.due) return '';
  if (deadline.due.time && deadline.due.at) return new Date(deadline.due.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return localDay(deadline.due.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const STATUS: Record<DeadlineStatus, [string, string]> = {
  completed: ['✓', 'Completed'], overdue: ['!', 'Overdue'], today: ['●', 'Due today'], upcoming: ['○', 'Upcoming'], none: ['○', 'No date yet'],
};

export const DeadlineBlock: React.FC<Common & { block: Extract<BoardBlock, { type: 'deadline' }>; onEdit: Edit<BoardDeadline> }> = ({ block, onEdit, onFlush, onExit, onRemove, onMove, phone, first, last }) => {
  const card = useRef<HTMLDivElement>(null);
  const [deadline, setDeadline] = useSaved(block.deadline, card);
  const composing = useRef(false);
  const now = useMinuteClock();
  const status = deadlineStatus(deadline, now);
  const send = (next: BoardDeadline, saveNow = false) => { setDeadline(next); if (!composing.current || saveNow) onEdit(next, saveNow); };
  // The exact moment a date and time mean here, in UTC (null for a date-only deadline).
  const withDue = (date: string, time: string | null) => (date ? { date, time, at: time ? new Date(`${date}T${time}`).toISOString() : null } : null);
  const typing = (key: 'title' | 'note', max: number) => ({
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => send({ ...deadline, [key]: clip(e.target.value, max) }),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => { composing.current = false; send({ ...deadline, [key]: clip((e.target as HTMLInputElement).value, max) }); },
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onExit(); } },
  });
  const [icon, word] = STATUS[status];
  const idBase = `deadline-${block.id}`;

  return (
    <div ref={card} className={`board-deadline-card status-${status}`} onBlur={leaveSaves(onFlush)}>
      <div className="board-note-top">
        <span className="board-note-kind">Deadline</span>
        <ItemActions className="board-block-menu" label="Options for this deadline">
          {deadline.due?.time && <button type="button" onClick={() => send({ ...deadline, due: withDue(deadline.due!.date, null) }, true)}>Remove time</button>}
          <MoveItems phone={phone} first={first} last={last} onMove={onMove} />
          <button type="button" onClick={onRemove}>Remove from board</button>
        </ItemActions>
      </div>
      <input className="board-deadline-title" value={deadline.title} placeholder="What is due?" aria-label="Deadline title" maxLength={LIMIT.deadlineTitle + 2} {...typing('title', LIMIT.deadlineTitle)} />
      <div className="board-deadline-row">
        <p className="board-deadline-status" aria-live="polite">
          <span className="board-deadline-icon" aria-hidden="true">{icon}</span>
          <span>{word}{deadline.due && status !== 'none' ? ` · ${dueText(deadline)}` : ''}</span>
        </p>
        <button type="button" className="board-deadline-done" aria-pressed={Boolean(deadline.completedAt)}
          aria-label={deadline.completedAt ? `Reopen ${deadline.title || 'this deadline'}` : `Mark ${deadline.title || 'this deadline'} complete`}
          onClick={() => send({ ...deadline, completedAt: deadline.completedAt ? null : new Date().toISOString() }, true)}>
          {deadline.completedAt ? 'Reopen' : 'Complete'}
        </button>
      </div>
      <div className="board-deadline-body">
        <div className="board-deadline-when">
          <label htmlFor={`${idBase}-date`} className="boards-visually-hidden">Due date</label>
          <input id={`${idBase}-date`} type="date" className="board-deadline-date" min="2000-01-01" max="2100-12-31" value={deadline.due?.date || ''}
            onChange={e => send({ ...deadline, due: withDue(e.target.value, deadline.due?.time || null) }, true)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onExit(); } }} />
          {deadline.due && (
            <>
              <label htmlFor={`${idBase}-time`} className="boards-visually-hidden">Due time (optional)</label>
              <input id={`${idBase}-time`} type="time" className="board-deadline-time" value={deadline.due.time || ''}
                onChange={e => send({ ...deadline, due: withDue(deadline.due!.date, e.target.value || null) }, true)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onExit(); } }} />
            </>
          )}
        </div>
        <textarea className="board-deadline-note" value={deadline.note} placeholder="Note (optional)" aria-label="Deadline note" {...typing('note', LIMIT.deadlineNote)} />
      </div>
    </div>
  );
};
