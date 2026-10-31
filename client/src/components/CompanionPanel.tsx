import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AIAssistant, { AssistantSuggestion } from './AIAssistant';
import CompanionSuggestions from './CompanionSuggestions';
import { CompanionFocus, useCompanion } from '../context/CompanionContext';
import { companionAPI, homeAPI, CompanionProactivity, CompanionTone } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import { AIAssistantIcon, CloseIcon, SettingsIcon, TrashIcon, EyeIcon } from './Icons';
import { glance, ScreenGlance } from '../companion/screen';
import './CompanionPanel.css';

/**
 * File Box AI as a companion on every page: a button in the corner opens a side panel with the same
 * conversation as the File Box AI page. It knows which page the person is on, checks in with what it
 * noticed, and has its own settings (name, tone, how often it speaks up, memory).
 */

const SEEN_KEY = 'filebox-companion-seen';
const NOTE_DAY_KEY = 'filebox-companion-note-day';

// What the companion offers first, depending on the page.
const PAGE_SUGGESTIONS: Record<string, AssistantSuggestion[]> = {
  home: [
    { label: 'What should I tidy up?', prompt: 'Organize my files' },
    { label: 'Find duplicate files', prompt: 'Find duplicate files' },
    { label: 'Find a document', prompt: 'Find documents about ' },
  ],
  files: [
    { label: 'Organize my files', prompt: 'Organize my files' },
    { label: 'Create a folder', prompt: 'Create a folder called ' },
    { label: 'Find a document', prompt: 'Find documents about ' },
    { label: 'Search inside documents', prompt: 'Which document mentions ' },
  ],
  shared: [
    { label: 'Find something shared with me', prompt: 'Find documents about ' },
    { label: 'Share a file', prompt: 'Share this file with ' },
  ],
  recent: [
    { label: 'Summarize a recent file', prompt: 'Summarize ' },
    { label: 'Find a document', prompt: 'Find documents about ' },
  ],
};
const DEFAULT_SUGGESTIONS: AssistantSuggestion[] = [
  { label: 'Find a document', prompt: 'Find documents about ' },
  { label: 'Search inside documents', prompt: 'Which document mentions ' },
  { label: 'Organize my files', prompt: 'Organize my files' },
  { label: 'Remember something', prompt: 'Remember that ' },
];

const TONES: Array<{ id: CompanionTone; label: string; hint: string }> = [
  { id: 'friendly', label: 'Friendly', hint: 'Warm, like a helpful friend' },
  { id: 'concise', label: 'Concise', hint: 'Short and to the point' },
  { id: 'professional', label: 'Professional', hint: 'Polished, like a work assistant' },
  { id: 'playful', label: 'Playful', hint: 'Light, with a bit of humor' },
];
const PROACTIVITY: Array<{ id: CompanionProactivity; label: string; hint: string }> = [
  { id: 'quiet', label: 'Quiet', hint: 'Only speaks when you ask' },
  { id: 'balanced', label: 'Balanced', hint: 'A dot on the button when it has something for you' },
  { id: 'chatty', label: 'Chatty', hint: 'Also a short note once a day' },
];

/** The context line under the title: what Ask File Box is looking at. */
export function focusLabel(focus: CompanionFocus) {
  if (focus.kind === 'file' && focus.file) return { lead: 'Looking at', name: focus.file.name };
  if (focus.kind === 'selection' && focus.selection) {
    const n = focus.selection.length;
    const allFiles = focus.selection.every(item => item.type === 'file');
    const allFolders = focus.selection.every(item => item.type === 'folder');
    return { lead: '', name: `${n} ${allFiles ? (n === 1 ? 'file' : 'files') : allFolders ? (n === 1 ? 'folder' : 'folders') : 'items'} selected` };
  }
  if (focus.kind === 'folder' && focus.folder) return { lead: 'Current folder', name: focus.folder.name };
  return { lead: 'On', name: focus.page || 'File Box' };
}

// ---------- Quick actions: only what makes sense for what is being looked at

type QuickAction = { label: string; text: string; mode?: 'send' | 'prefill' };

const isImage = (mime?: string) => Boolean(mime && mime.startsWith('image/'));
const isDocument = (mime?: string) => Boolean(mime && (/^text\//.test(mime) || /pdf|word|document|sheet|excel|presentation|powerpoint|rtf|json|xml|csv|markdown|javascript|typescript|x-python|x-sh/.test(mime)));

export function quickActionsFor(focus: CompanionFocus, problem?: string): QuickAction[] {
  const help: QuickAction[] = problem ? [{ label: 'Help with this message', text: `I see this message: "${problem}". What does it mean and what should I do?` }] : [];
  if (focus.kind === 'file' && focus.file) {
    const { mimeType } = focus.file;
    const changes: QuickAction[] = [
      { label: 'Rename', text: 'Rename this to ', mode: 'prefill' },
      { label: 'Move', text: 'Move this into ', mode: 'prefill' },
    ];
    if (isImage(mimeType)) {
      return [{ label: 'Describe', text: 'Describe this picture' }, { label: 'Read text', text: 'What text is written in this picture?' }, ...changes, ...help];
    }
    if (isDocument(mimeType) || !mimeType) {
      return [
        { label: 'Summarize', text: 'Summarize this' },
        { label: 'Explain', text: 'Explain this in simple words' },
        { label: 'Key points', text: 'What are the key points of this file?' },
        { label: 'Find dates', text: 'What dates does this file mention?' },
        ...changes, ...help,
      ];
    }
    return [{ label: 'What is this?', text: 'What is this file?' }, ...changes, ...help];
  }
  if (focus.kind === 'selection' && focus.selection) {
    // Summarize and Compare work on selected files (the server allows up to 8 and 2-5 of them).
    const files = focus.selection.filter(item => item.type === 'file').length;
    return [
      ...(files >= 2 ? [{ label: 'Summarize', text: 'Summarize these' }] : []),
      ...(files >= 2 && files <= 5 ? [{ label: 'Compare', text: 'Compare these' }] : []),
      ...(files >= 1 ? [{ label: 'Move', text: 'Move these into ', mode: 'prefill' as const }] : []),
      ...help,
    ];
  }
  if (focus.kind === 'folder') {
    return [
      { label: 'Summarize folder', text: 'Summarize this folder' },
      { label: 'Organize', text: 'Organize this folder' },
      { label: 'Find duplicates', text: 'Find duplicate files' },
      { label: 'Find related files', text: 'Find related files' },
      ...help,
    ];
  }
  return help;
}

const CompanionSettings: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { profile, setProfile, name } = useCompanion();
  const [draftName, setDraftName] = useState(profile.name);
  const [memory, setMemory] = useState('');
  const [error, setError] = useState('');

  const save = (patch: Parameters<typeof companionAPI.update>[0]) => {
    setError('');
    setProfile({ ...profile, ...patch });
    companionAPI.update(patch).then(setProfile).catch(() => setError('Could not save that. Check that File Box is running.'));
  };
  const run = (call: Promise<typeof profile>) => call.then(setProfile).catch(() => setError('Could not save that. Check that File Box is running.'));

  return (
    <div className="companion-settings">
      <label className="companion-field">
        <strong>Name</strong>
        <input value={draftName} maxLength={30} placeholder="File Box AI" onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => draftName !== profile.name && save({ name: draftName.trim() })}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
        <small>What you'd like to call {name === 'File Box AI' ? 'me' : name}.</small>
      </label>

      <fieldset className="companion-field">
        <legend>How I talk</legend>
        <div className="companion-options">
          {TONES.map(tone => (
            <button key={tone.id} className={profile.tone === tone.id ? 'selected' : ''} aria-pressed={profile.tone === tone.id} onClick={() => save({ tone: tone.id })}>
              <strong>{tone.label}</strong><small>{tone.hint}</small>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="companion-field">
        <legend>How often I speak up</legend>
        <div className="companion-options">
          {PROACTIVITY.map(option => (
            <button key={option.id} className={profile.proactivity === option.id ? 'selected' : ''} aria-pressed={profile.proactivity === option.id} onClick={() => save({ proactivity: option.id })}>
              <strong>{option.label}</strong><small>{option.hint}</small>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="companion-field">
        <label className="companion-switch">
          <input type="checkbox" checked={profile.screenAware} onChange={(event) => save({ screenAware: event.target.checked })} />
          <span><strong>Screen awareness</strong><small>When you ask me something, I read what’s on your File Box screen (the page, the files in view, an open preview or window, messages shown) and what you just did here, so I understand “this”. Only File Box is read, never other tabs or apps, and never passwords or what you type.</small></span>
        </label>
      </div>

      <div className="companion-field">
        <label className="companion-switch">
          <input type="checkbox" checked={profile.memoryOn} onChange={(event) => save({ memoryOn: event.target.checked })} />
          <span><strong>Memory</strong><small>Keep things you tell me (“remember that…”) and use them in answers. Stored with your account only.</small></span>
        </label>
        {profile.memoryOn && (
          <>
            <ul className="companion-memories" aria-label="What I remember">
              {profile.memories.map(m => (
                <li key={m.id}>
                  <span>{m.text}</span>
                  <button onClick={() => run(companionAPI.forget(m.id))} aria-label={`Forget: ${m.text}`} title="Forget this"><TrashIcon size={13} /></button>
                </li>
              ))}
              {!profile.memories.length && <li className="companion-memories-empty">Nothing yet. Tell me “remember that…” in the chat, or add something here.</li>}
            </ul>
            <form className="companion-add-memory" onSubmit={(event) => { event.preventDefault(); if (memory.trim()) { run(companionAPI.remember(memory.trim())); setMemory(''); } }}>
              <input value={memory} maxLength={300} placeholder="e.g. My tax papers go in Finance / 2026" onChange={(event) => setMemory(event.target.value)} aria-label="Something to remember" />
              <button className="btn-secondary" type="submit" disabled={!memory.trim()}>Remember</button>
            </form>
            {profile.memories.length > 0 && (
              <button className="companion-forget-all" onClick={() => { if (window.confirm('Forget everything you asked me to remember?')) run(companionAPI.forgetAll()); }}>Forget everything</button>
            )}
          </>
        )}
      </div>
      {error && <p className="companion-error" role="alert">{error}</p>}
      <button className="btn-primary companion-done" onClick={onDone}>Back to chat</button>
    </div>
  );
};

interface CompanionPanelProps {
  currentView: string;
}

const CompanionPanel: React.FC<CompanionPanelProps> = ({ currentView }) => {
  const navigate = useNavigate();
  const { open, setOpen, name, profile, setProfile, ask, focus } = useCompanion();
  const context = focusLabel(focus);
  const [screen, setScreen] = useState<ScreenGlance>({});
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [news, setNews] = useState<{ key: string; text: string } | null>(null);
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } });
  const [noteShown, setNoteShown] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // After closing, focus goes back to the Ask File Box button (it only exists again once closed).
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!open && returnFocus.current) { returnFocus.current = false; buttonRef.current?.focus(); }
  });
  const onAiPage = currentView === 'ai-assistant';

  // What the companion noticed (the same suggestions as Home), checked now and then.
  useEffect(() => {
    if (profile.proactivity === 'quiet') { setNews(null); return undefined; }
    const check = () => homeAPI.getOverview()
      .then(overview => {
        const top = overview.suggestions?.[0];
        setNews(top ? { key: overview.suggestions.map(s => `${s.id}:${s.fingerprint}`).join('|'), text: top.noticed } : null);
      })
      .catch(() => { /* nothing to say */ });
    check();
    const timer = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [profile.proactivity]);

  const hasNews = Boolean(news && news.key !== seen && profile.proactivity !== 'quiet');
  const today = new Date().toDateString();
  const showNote = hasNews && profile.proactivity === 'chatty' && !open && !onAiPage && !noteShown
    && (() => { try { return localStorage.getItem(NOTE_DAY_KEY) !== today; } catch { return true; } })();

  const markSeen = () => {
    if (!news) return;
    setSeen(news.key);
    try { localStorage.setItem(SEEN_KEY, news.key); } catch { /* only for this visit */ }
  };
  const dismissNote = () => {
    setNoteShown(true);
    try { localStorage.setItem(NOTE_DAY_KEY, today); } catch { /* only for this visit */ }
  };

  const toggle = (next = !open) => {
    // Closing from the panel on a phone also removes the Back step it added.
    if (!next && pushedBack.current) { pushedBack.current = false; window.history.back(); }
    setOpen(next);
    if (next) { markSeen(); dismissNote(); setView('chat'); } else returnFocus.current = true;
  };

  // Phones: the panel is a bottom sheet, and the phone's Back button closes it (as people expect).
  const isPhone = () => window.matchMedia('(max-width: 600px)').matches;
  const pushedBack = useRef(false);
  useEffect(() => {
    if (!open || onAiPage || !isPhone()) return undefined;
    window.history.pushState({ ...(window.history.state || {}), fileboxCompanion: true }, '');
    pushedBack.current = true;
    const onBack = () => { pushedBack.current = false; setOpen(false); };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [open, onAiPage, setOpen]);

  // ⌘J / Ctrl+J opens and closes the companion anywhere; Escape closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); if (!onAiPage) toggle(); }
      if (event.key === 'Escape' && open && panelRef.current?.contains(document.activeElement)) toggle(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (open && !onAiPage) panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [open, onAiPage, view]);

  // While open (and allowed), keep an eye on what is showing, to offer help with it.
  useEffect(() => {
    if (!open || !profile.screenAware) { setScreen({}); return undefined; }
    const look = () => setScreen(current => {
      const next = glance();
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    look();
    const timer = setInterval(look, 1500);
    return () => clearInterval(timer);
  }, [open, profile.screenAware]);

  const actions = quickActionsFor(focus, profile.screenAware ? screen.problem : undefined);

  const toggleAware = () => {
    const screenAware = !profile.screenAware;
    setProfile({ ...profile, screenAware });
    companionAPI.update({ screenAware }).then(setProfile).catch(() => setProfile({ ...profile }));
  };

  if (onAiPage) return null;

  return (
    <>
      {!open && (
        <div className="companion-launcher">
          {showNote && news && (
            <div className="companion-note" role="status">
              <button className="companion-note-body" onClick={() => toggle(true)}>
                <strong>{name}</strong>
                <span>I noticed {news.text.charAt(0).toLowerCase() + news.text.slice(1)} Want a hand?</span>
              </button>
              <button className="companion-note-close" onClick={dismissNote} aria-label="Dismiss"><CloseIcon size={12} /></button>
            </div>
          )}
          <button ref={buttonRef} className="companion-button" onClick={() => toggle(true)} aria-label={`Ask File Box${hasNews ? ' (has something for you)' : ''}. Shortcut: Command J`} title="Ask File Box (⌘J)">
            <AIAssistantIcon size={18} />
            <span>Ask File Box</span>
            {hasNews && <span className="companion-dot" aria-hidden="true" />}
          </button>
        </div>
      )}

      {open && <button className="companion-sheet-backdrop" aria-label="Close Ask File Box" onClick={() => toggle(false)} />}
      {open && (
        <aside ref={panelRef} className="companion-panel" aria-label="Ask File Box">
          <span className="companion-sheet-handle" aria-hidden="true" />
          <header className="companion-panel-header">
            <span className="companion-avatar" aria-hidden="true"><AIAssistantIcon size={16} /></span>
            <span className="companion-title">
              <strong>Ask File Box{view === 'settings' ? ' · Settings' : ''}</strong>
              {view === 'chat' && (
                <small className="companion-context" aria-live="polite" title={`${context.lead ? `${context.lead}: ` : ''}${context.name}`}>
                  {context.lead && `${context.lead}: `}<b>{context.name}</b>
                </small>
              )}
            </span>
            <span className="companion-panel-actions">
              <button className={`companion-eye ${profile.screenAware ? 'on' : ''}`} onClick={toggleAware} aria-pressed={profile.screenAware}
                aria-label={profile.screenAware ? `${name} can see your File Box screen. Turn off` : `${name} can't see your screen. Turn on`}
                title={profile.screenAware ? 'Can see your File Box screen (click to turn off)' : 'Not looking at your screen (click to turn on)'}><EyeIcon size={16} /></button>
              <button onClick={() => setView(view === 'settings' ? 'chat' : 'settings')} aria-label={view === 'settings' ? 'Back to chat' : `${name} settings`} aria-pressed={view === 'settings'} title="Settings"><SettingsIcon size={16} /></button>
              <button onClick={() => { toggle(false); navigate(pagePath('ai-assistant')); }} aria-label="Expand to the full File Box AI page" title="Expand to full page">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
              </button>
              <button onClick={() => toggle(false)} aria-label={`Close ${name}`} title="Close (Esc)"><CloseIcon size={16} /></button>
            </span>
          </header>
          {view === 'chat' && actions.length > 0 && (
            <div className="companion-actions" role="toolbar" aria-label={`Quick actions for ${context.name}`}>
              {actions.map(action => (
                <button key={action.label} onClick={() => ask(action.text, undefined, action.mode)}>{action.label}</button>
              ))}
            </div>
          )}
          {view === 'chat' && <CompanionSuggestions />}
          <div className="companion-panel-body">
            {view === 'settings'
              ? <CompanionSettings onDone={() => setView('chat')} />
              : <AIAssistant variant="panel" suggestions={PAGE_SUGGESTIONS[currentView] || DEFAULT_SUGGESTIONS} />}
          </div>
        </aside>
      )}
    </>
  );
};

export default CompanionPanel;
