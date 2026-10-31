import React, { useEffect, useState } from 'react';
import { homeAPI, HomeOverview } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCompanion } from '../context/CompanionContext';
import { ArrowRightIcon, DocumentIcon } from './Icons';

/**
 * How File Box AI checks in when the person opens it: a greeting in its own tone, the file they were
 * last working on, what it noticed (the same suggestions as Home), and where the last conversation left off.
 */

interface CompanionGreetingProps {
  lastTopic?: string;
  onAsk: (text: string) => void;
  onPrefill: (text: string) => void;
  onOpenFile: (file: { id: string; name: string; parentFolder?: string | null }) => void;
  onNavigate: (page: string) => void;
}

const DISMISSED_KEY = 'filebox-dismissed-suggestions';
const readDismissed = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}') || {}; } catch { return {}; }
};

const partOfDay = () => {
  const hour = new Date().getHours();
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
};

// A first line in the companion's own voice.
const opener = (tone: string, first: string) => {
  const you = first ? `, ${first}` : '';
  switch (tone) {
    case 'concise': return `Good ${partOfDay()}${you}.`;
    case 'professional': return `Good ${partOfDay()}${you}. Here's where things stand.`;
    case 'playful': return `Hey${you}! Your files and I were just talking about you.`;
    default: return `Good ${partOfDay()}${you}. Here's what I've got for you.`;
  }
};

const CompanionGreeting: React.FC<CompanionGreetingProps> = ({ lastTopic, onAsk, onPrefill, onOpenFile, onNavigate }) => {
  const { user, isLocalPreview } = useAuth();
  const { profile } = useCompanion();
  const [overview, setOverview] = useState<HomeOverview | null>(null);

  useEffect(() => {
    homeAPI.getOverview().then(setOverview).catch(() => setOverview(null));
  }, []);

  const first = isLocalPreview ? '' : (user?.name || '').split(' ')[0];
  const dismissed = readDismissed();
  const noticed = (overview?.suggestions || []).filter(s => dismissed[s.id] !== s.fingerprint).slice(0, 2);
  const recent = overview?.continueWorking?.[0];

  return (
    <section className="companion-greeting" aria-label="What's new">
      <p className="companion-greeting-hello">{opener(profile.tone, first)}</p>

      {recent && (
        <div className="companion-greeting-item">
          <span>You were last working on</span>
          <button className="companion-greeting-file" onClick={() => onOpenFile({ id: recent._id, name: recent.originalName, parentFolder: recent.parentFolder })}>
            <DocumentIcon size={14} /><strong>{recent.originalName}</strong><ArrowRightIcon size={12} />
          </button>
          <button className="companion-greeting-link" onClick={() => onAsk(`Summarize ${recent.originalName}`)}>Remind me what's in it</button>
        </div>
      )}

      {noticed.map(suggestion => (
        <div key={suggestion.id} className="companion-greeting-item">
          <span>I noticed: <strong>{suggestion.noticed}</strong></span>
          <button className="companion-greeting-link" onClick={() => {
            if (suggestion.action.type === 'duplicates') onAsk('Find duplicate files');
            else if (suggestion.action.type === 'organize') onAsk('Organize my files');
            else onNavigate(suggestion.action.to || 'home');
          }}>{suggestion.action.label}</button>
        </div>
      ))}

      {lastTopic && (
        <div className="companion-greeting-item">
          <span>Last time you asked me: <q>{lastTopic.length > 90 ? `${lastTopic.slice(0, 90)}…` : lastTopic}</q></span>
          <button className="companion-greeting-link" onClick={() => onPrefill(lastTopic)}>Pick up from there</button>
        </div>
      )}

      {overview && !recent && !noticed.length && !lastTopic && (
        <p className="companion-greeting-quiet">All quiet in your files. Ask me anything, or tell me something to remember.</p>
      )}
    </section>
  );
};

export default CompanionGreeting;
