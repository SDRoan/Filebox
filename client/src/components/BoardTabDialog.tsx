import React, { useRef, useState } from 'react';
import BoardDialog from './BoardDialog';
import { TAB_COLORS, TAB_EMOJI, oneEmoji, tabAccent } from '../utils/boardTabs';

export interface TabLook { name: string; icon: string; color: string }

/**
 * Arrow keys inside a radio group (one Tab stop): left/right go to the previous/next option, up/down to
 * the option above/below as laid out on screen, Home/End to the first/last. Moving also selects; Enter submits.
 */
function onRadioKeys(event: React.KeyboardEvent<HTMLDivElement>, choose: (value: string) => void) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  // As with ordinary radio buttons, Enter submits the form.
  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.closest('form')?.requestSubmit(); return; }
  let next = -1;
  if (event.key === 'ArrowRight') next = (i + 1) % items.length;
  else if (event.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const here = items[i].getBoundingClientRect();
    const down = event.key === 'ArrowDown';
    const row = items.filter(el => { const r = el.getBoundingClientRect(); return down ? r.top > here.top + 4 : r.top < here.top - 4; });
    if (!row.length) { event.preventDefault(); return; }
    const top = down ? Math.min(...row.map(el => el.getBoundingClientRect().top)) : Math.max(...row.map(el => el.getBoundingClientRect().top));
    const line = row.filter(el => Math.abs(el.getBoundingClientRect().top - top) < 4);
    const best = line.reduce((a, b) => (Math.abs(b.getBoundingClientRect().left - here.left) < Math.abs(a.getBoundingClientRect().left - here.left) ? b : a));
    next = items.indexOf(best);
  }
  if (next < 0) return;
  event.preventDefault();
  items[next].focus();
  choose(items[next].dataset.value || '');
}

/** New tab or Edit tab: name, emoji and accent colour, with a preview of the tab. */
const BoardTabDialog: React.FC<{
  mode: 'create' | 'edit';
  initial: TabLook;
  max: number;
  onSave: (look: TabLook) => Promise<string | null>;
  onClose: () => void;
}> = ({ mode, initial, max, onSave, onClose }) => {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [color, setColor] = useState(initial.color);
  const [typed, setTyped] = useState(initial.icon && !TAB_EMOJI.some(([e]) => e === initial.icon) ? initial.icon : '');
  const [typedError, setTypedError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const length = Array.from(name.trim()).length;
  const unchanged = mode === 'edit' && name.trim() === initial.name && icon === initial.icon && color === initial.color;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError('Give the tab a name.'); return; }
    if (typedError) return;
    setSaving(true);
    const problem = await onSave({ name, icon, color });
    if (problem) {
      setError(problem);
      setSaving(false);
      setTimeout(() => nameRef.current?.focus(), 0);
    }
  };
  const emojiOptions: Array<[string, string]> = [['', 'No emoji'], ...TAB_EMOJI];
  const colorOptions: Array<[string, string]> = [['', 'No color'], ...Object.entries(TAB_COLORS).map(([k, v]) => [k, v.label] as [string, string])];
  const iconInList = emojiOptions.some(([e]) => e === icon);
  const accent = tabAccent(color);

  return (
    <BoardDialog title={mode === 'create' ? 'New tab' : 'Edit tab'} wide onClose={onClose}>
      <form onSubmit={submit} className="board-tab-form">
        <div className="board-tab-preview" aria-hidden="true">
          <span className={`boards-tab is-active ${accent ? 'has-color' : ''}`} style={accent ? { ['--tab-accent' as any]: accent } : undefined}>
            {icon && <span className="boards-tab-icon">{icon}</span>}
            <span className="boards-tab-name">{name.trim() || 'Tab name'}</span>
          </span>
        </div>

        <label className="boards-field">
          <span>Tab name</span>
          <input ref={nameRef} value={name} maxLength={max + 10} onChange={event => { setName(event.target.value); setError(''); }}
            placeholder="Work, School, Bills, Project A…" aria-invalid={Boolean(error) || length > max} aria-describedby="boards-name-help" disabled={saving} />
        </label>
        <p id="boards-name-help" className={`boards-field-help ${length > max ? 'is-over' : ''}`}>{length}/{max}</p>

        <fieldset className="board-tab-fieldset">
          <legend id="board-tab-emoji-label">Emoji</legend>
          <div className="board-emoji-grid" role="radiogroup" aria-labelledby="board-tab-emoji-label" onKeyDown={e => onRadioKeys(e, v => { setIcon(v); setTyped(''); setTypedError(''); })}>
            {emojiOptions.map(([value, label]) => {
              const on = icon === value;
              return (
                <button key={label} type="button" role="radio" aria-checked={on} aria-label={label} title={label} data-value={value}
                  tabIndex={on || (!iconInList && value === '' && Boolean(icon)) ? 0 : -1}
                  className={`board-emoji ${on ? 'is-on' : ''}`} onClick={() => { setIcon(value); setTyped(''); setTypedError(''); }} disabled={saving}>
                  {value || <span className="board-emoji-none" aria-hidden="true">∅</span>}
                </button>
              );
            })}
          </div>
          <label className="boards-field board-emoji-typed">
            <span>Or type any emoji</span>
            <input value={typed} maxLength={16} placeholder="🙂" aria-invalid={Boolean(typedError)} aria-describedby={typedError ? 'board-emoji-error' : undefined} disabled={saving}
              onChange={(event) => {
                const value = event.target.value;
                setTyped(value);
                if (!value.trim()) { setTypedError(''); if (!iconInList) setIcon(''); return; }
                const one = oneEmoji(value);
                setTypedError(one ? '' : 'Use one emoji.');
                if (one) setIcon(one);
              }} />
          </label>
          {typedError && <p id="board-emoji-error" className="boards-dialog-error" role="alert">{typedError}</p>}
        </fieldset>

        <fieldset className="board-tab-fieldset">
          <legend id="board-tab-color-label">Color</legend>
          <div className="board-color-grid" role="radiogroup" aria-labelledby="board-tab-color-label" onKeyDown={e => onRadioKeys(e, setColor)}>
            {colorOptions.map(([value, label]) => {
              const on = color === value;
              return (
                <button key={label} type="button" role="radio" aria-checked={on} aria-label={label} title={label} data-value={value} tabIndex={on ? 0 : -1}
                  className={`board-color ${on ? 'is-on' : ''} ${value ? '' : 'is-none'}`} style={value ? { ['--swatch' as any]: TAB_COLORS[value].hex } : undefined}
                  onClick={() => setColor(value)} disabled={saving}>
                  <span className="board-color-dot" aria-hidden="true">{on ? '✓' : value ? '' : '∅'}</span>
                </button>
              );
            })}
          </div>
          <p className="board-color-name" aria-hidden="true">{colorOptions.find(([v]) => v === color)?.[1]}</p>
        </fieldset>

        {error && <p className="boards-dialog-error" role="alert">{error}</p>}
        <div className="boards-dialog-actions">
          <button type="button" className="boards-button-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="boards-button-primary" disabled={saving || !name.trim() || length > max || Boolean(typedError) || unchanged}>
            {saving ? 'Saving…' : mode === 'create' ? 'Create tab' : 'Save'}
          </button>
        </div>
      </form>
    </BoardDialog>
  );
};

export default BoardTabDialog;
