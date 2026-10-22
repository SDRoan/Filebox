import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FONTS, FontChoice, FontId, fontName, fontStack } from '../theme/appearance';
import {
  CATEGORY_LABELS, FONT_FAMILY_PATTERN, FontCategory, GOOGLE_FONTS, canListLocalFonts, customFontStack, listLocalFonts, loadGoogleFont,
} from '../theme/fonts';
import { CheckIcon, ChevronDownIcon, SearchIcon } from './Icons';
import './FontSelect.css';

type Filter = 'all' | 'filebox' | FontCategory | 'local';

type Option = { choice: FontChoice; name: string; stack: string; group: string; googleFamily?: string };

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'filebox', label: 'File Box' },
  ...(Object.keys(CATEGORY_LABELS) as FontCategory[]).map(id => ({ id, label: CATEGORY_LABELS[id] })),
  { id: 'local', label: 'This computer' },
];

const FILEBOX_OPTIONS: Option[] = (Object.keys(FONTS) as FontId[]).map(id => ({ choice: id, name: FONTS[id].label, stack: FONTS[id].stack, group: 'File Box' }));
const GOOGLE_OPTIONS: Array<Option & { category: FontCategory }> = GOOGLE_FONTS.map(([family, category]) => ({
  choice: `google:${family}`, name: family, stack: customFontStack('google', family), group: `Google Fonts · ${CATEGORY_LABELS[category]}`, googleFamily: family, category,
}));

/** One font in the list; its preview font loads only once it scrolls into view. */
const FontOption: React.FC<{ option: Option; id: string; selected: boolean; active: boolean; onChoose: () => void; onHover: () => void }> = ({
  option, id, selected, active, onChoose, onHover,
}) => {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!option.googleFamily || !ref.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        loadGoogleFont(option.googleFamily!, option.name);
        observer.disconnect();
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [option.googleFamily, option.name]);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return (
    <li ref={ref} id={id} role="option" aria-selected={selected} className={`font-option ${active ? 'active' : ''}`}
      onMouseDown={(event) => event.preventDefault()} onClick={onChoose} onMouseEnter={onHover}>
      <span style={{ fontFamily: option.stack }}>{option.name}</span>
      {selected && <CheckIcon size={14} />}
    </li>
  );
};

/**
 * Settings > Customize: choose any font — File Box's own, any Google font (search or type its name), or
 * one installed on this computer.
 */
const FontSelect: React.FC<{ label: string; value: FontChoice; onChange: (font: FontChoice) => void }> = ({ label, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [active, setActive] = useState(0);
  const [localFonts, setLocalFonts] = useState<string[] | null>(null);
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const closeOnOutside = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  const q = query.trim();
  const options = useMemo(() => {
    const matches = (name: string) => !q || name.toLowerCase().includes(q.toLowerCase());
    const list: Option[] = [];
    if (filter === 'all' || filter === 'filebox') list.push(...FILEBOX_OPTIONS.filter(o => matches(o.name)));
    list.push(...GOOGLE_OPTIONS.filter(o => (filter === 'all' || filter === o.category) && matches(o.name)));
    if ((filter === 'all' || filter === 'local') && localFonts) {
      list.push(...localFonts.filter(matches).map(family => ({
        choice: `local:${family}`, name: family, stack: customFontStack('local', family), group: 'On this computer',
      })));
    }
    // Anything not listed: use it by name from Google Fonts or from this computer.
    const exact = list.some(o => o.name.toLowerCase() === q.toLowerCase());
    if (q && !exact && FONT_FAMILY_PATTERN.test(q)) {
      list.push({ choice: `google:${q}`, name: `“${q}” from Google Fonts`, stack: customFontStack('google', q), group: 'Use a font by name', googleFamily: q });
      list.push({ choice: `local:${q}`, name: `“${q}” installed on this computer`, stack: customFontStack('local', q), group: 'Use a font by name' });
    }
    return list;
  }, [q, filter, localFonts]);

  useEffect(() => { setActive(0); }, [q, filter]);

  const choose = async (option: Option) => {
    setNote('');
    if (option.googleFamily && option.group === 'Use a font by name') {
      setNote(`Looking for “${option.googleFamily}”…`);
      if (!(await loadGoogleFont(option.googleFamily))) {
        setNote(`Google Fonts has no font called “${option.googleFamily}”. Check the spelling (for example “Playfair Display”).`);
        return;
      }
      setNote('');
    }
    onChange(option.choice);
    setOpen(false);
    setQuery('');
  };

  const showLocalFonts = async () => {
    try {
      setNote('Reading the fonts on this computer…');
      const fonts = await listLocalFonts();
      setLocalFonts(fonts);
      setFilter('local');
      setNote(fonts.length ? '' : 'No installed fonts were found.');
    } catch {
      setNote('The browser did not allow File Box to see your fonts. You can still type a font’s name above.');
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active]); }
  };

  return (
    <div className="font-select" ref={rootRef}>
      <h3>{label}</h3>
      <button className="font-select-button" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${fontName(value)}`}>
        <span style={{ fontFamily: fontStack(value) }}>{fontName(value)}</span>
        <ChevronDownIcon size={16} />
      </button>
      <p className="font-select-sample" style={{ fontFamily: fontStack(value) }}>The quick brown fox jumps over the lazy dog. 0123456789</p>

      {open && (
        <div className="font-select-popover" onKeyDown={onKeyDown}>
          <div className="font-select-search">
            <SearchIcon size={15} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fonts or type any font name"
              role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={options[active] ? `${listId}-${active}` : undefined} aria-label={`Search ${label.toLowerCase()}`} />
          </div>
          <div className="font-select-filters" role="group" aria-label="Kind of font">
            {FILTERS.filter(f => f.id !== 'local' || canListLocalFonts() || localFonts).map(f => (
              <button key={f.id} className={filter === f.id ? 'selected' : ''} aria-pressed={filter === f.id}
                onClick={() => { if (f.id === 'local' && !localFonts) showLocalFonts(); else setFilter(f.id); }}>{f.label}</button>
            ))}
          </div>
          {note && <p className="font-select-note" role="status">{note}</p>}
          <ul className="font-select-list" role="listbox" id={listId} aria-label={label}>
            {options.map((option, index) => (
              <React.Fragment key={option.choice}>
                {(index === 0 || options[index - 1].group !== option.group) && <li className="font-select-group" role="presentation">{option.group}</li>}
                <FontOption option={option} id={`${listId}-${index}`} selected={option.choice === value} active={index === active}
                  onChoose={() => choose(option)} onHover={() => setActive(index)} />
              </React.Fragment>
            ))}
            {!options.length && <li className="font-select-empty" role="presentation">No fonts match “{q}”.</li>}
          </ul>
          {canListLocalFonts() && !localFonts && (
            <button className="font-select-local" onClick={showLocalFonts}>Show fonts installed on this computer</button>
          )}
        </div>
      )}
    </div>
  );
};

export default FontSelect;
