import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AIAssistant, { AssistantSuggestion } from './AIAssistant';
import { useCompanion } from '../context/CompanionContext';
import { companionAPI, homeAPI, CompanionProactivity, CompanionTone } from '../services/api';
import { pagePath } from '../config/workspaceNavigation';
import { AIAssistantIcon, CloseIcon, SettingsIcon, TrashIcon, ArrowRightIcon } from './Icons';
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
  const { open, setOpen, name, profile } = useCompanion();
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [news, setNews] = useState<{ key: string; text: string } | null>(null);
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } });
  const [noteShown, setNoteShown] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
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
    setOpen(next);
    if (next) { markSeen(); dismissNote(); setView('chat'); } else buttonRef.current?.focus();
  };

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
          <button ref={buttonRef} className="companion-button" onClick={() => toggle(true)} aria-label={`Open ${name}${hasNews ? ' (has something for you)' : ''}. Shortcut: Command J`} title={`${name} (⌘J)`}>
            <AIAssistantIcon size={22} />
            {hasNews && <span className="companion-dot" aria-hidden="true" />}
          </button>
        </div>
      )}

      {open && (
        <aside ref={panelRef} className="companion-panel" aria-label={name}>
          <header className="companion-panel-header">
            <span className="companion-avatar" aria-hidden="true"><AIAssistantIcon size={16} /></span>
            <strong>{view === 'settings' ? `${name} settings` : name}</strong>
            <span className="companion-panel-actions">
              <button onClick={() => setView(view === 'settings' ? 'chat' : 'settings')} aria-label={view === 'settings' ? 'Back to chat' : `${name} settings`} aria-pressed={view === 'settings'} title="Settings"><SettingsIcon size={16} /></button>
              <button onClick={() => { toggle(false); navigate(pagePath('ai-assistant')); }} aria-label="Open the full File Box AI page" title="Open full page"><ArrowRightIcon size={16} /></button>
              <button onClick={() => toggle(false)} aria-label={`Close ${name}`} title="Close (Esc)"><CloseIcon size={16} /></button>
            </span>
          </header>
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
