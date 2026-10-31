import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { companionAPI, CompanionSuggestion } from '../services/api';
import { CompanionFocus, useCompanion } from '../context/CompanionContext';
import { useAuth } from '../context/AuthContext';
import { pagePath } from '../config/workspaceNavigation';
import { CloseIcon } from './Icons';

/**
 * Ask File Box's "Noticed" row: up to 3 small suggestions about what the person is looking at, from
 * File Box's own data (the server never asks the AI model to decide them). Fetched only while the panel
 * is open, when the focus changes, and kept for 5 minutes per focus. Nothing runs until clicked, and a
 * dismissed suggestion stays hidden until the data behind it changes (its key includes a fingerprint).
 */

const SHOWN = 3;
const CACHE_MS = 5 * 60 * 1000;
const KEEP_DISMISSED_MS = 14 * 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; items: CompanionSuggestion[] }>();

const dismissedKey = (userId: string) => `filebox-companion-dismissed-${userId}`;
function readDismissed(userId: string): Record<string, number> {
  try {
    const all: Record<string, number> = JSON.parse(localStorage.getItem(dismissedKey(userId)) || '{}') || {};
    return Object.fromEntries(Object.entries(all).filter(([, at]) => Date.now() - at < KEEP_DISMISSED_MS));
  } catch {
    return {};
  }
}

// What to ask the server about, from the focus (the server re-checks every id).
function focusQuery(focus: CompanionFocus) {
  if (focus.kind === 'file' && focus.file) return { fileId: focus.file.id };
  if (focus.kind === 'selection' && focus.selection) {
    const fileIds = focus.selection.filter(item => item.type === 'file').map(item => item.id);
    return fileIds.length >= 2 ? { fileIds } : null;
  }
  if (focus.kind === 'folder' && focus.folder) return { folderId: focus.folder.id };
  return {};
}

const CompanionSuggestions: React.FC = () => {
  const { focus, open, ask } = useCompanion();
  const { user } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id || 'local';
  const [items, setItems] = useState<CompanionSuggestion[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, number>>(() => readDismissed(userId));

  useEffect(() => {
    if (!open) return undefined;
    const key = focus.key;
    const query = focusQuery(focus);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) { setItems(cached.items); return undefined; }
    // A new file, folder or selection: its old suggestions go away at once.
    setItems([]);
    if (!query) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      companionAPI.suggestions(query)
        .then(({ suggestions }) => {
          cache.set(key, { at: Date.now(), items: suggestions });
          if (!cancelled) setItems(suggestions);
        })
        .catch(() => { /* no suggestions this time */ });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // focus.key changes whenever what is being looked at changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focus.key]);

  const dismiss = (item: CompanionSuggestion) => {
    const next = { ...readDismissed(userId), [item.key]: Date.now() };
    setDismissed(next);
    try { localStorage.setItem(dismissedKey(userId), JSON.stringify(next)); } catch { /* hidden for this visit */ }
  };

  const run = (item: CompanionSuggestion) => {
    const { action } = item;
    if (action.open) {
      navigate(pagePath('files'), { state: { openFolderId: action.open.parentFolder, highlightFileId: action.open.fileId } });
      return;
    }
    if (action.text) ask(action.text, undefined, action.mode);
  };

  const visible = items.filter(item => !dismissed[item.key]).slice(0, SHOWN);
  if (!visible.length) return null;

  return (
    <ul className="companion-noticed" aria-label="Noticed">
      {visible.map(item => (
        <li key={item.key} className={`companion-noticed-item ${item.kind}`}>
          <span className="companion-noticed-text" title={item.text}>{item.text}</span>
          <button className="companion-noticed-action" onClick={() => run(item)}>{item.action.label}</button>
          <button className="companion-noticed-dismiss" onClick={() => dismiss(item)} aria-label={`Dismiss: ${item.text}`} title="Dismiss"><CloseIcon size={12} /></button>
        </li>
      ))}
    </ul>
  );
};

export default CompanionSuggestions;
