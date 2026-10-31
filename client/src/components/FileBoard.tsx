import React, { useCallback, useEffect, useRef, useState } from 'react';
import { boardsAPI, BoardLayout } from '../services/api';
import BoardCanvas from './BoardCanvas';
import './FileBoard.css';

/**
 * My Files > Board: a free canvas where a person arranges files and folders their own way. They can
 * draw zones (boxes, circles, pills) with names and colors, drop items into them, and move a zone
 * with everything in it. Only the layout is saved (per person and folder); files stay where they are.
 * The canvas itself is shared with personal Boards (BoardCanvas); this keeps the folder's layout saved.
 */

export interface BoardEntry { key: string; name: string; render: () => React.ReactNode }

interface FileBoardProps {
  folderKey: string;
  entries: BoardEntry[];
}

const SAVE_DELAY_MS = 500;

const cacheKey = (folderKey: string) => `filebox-board-${folderKey}`;
const readCache = (folderKey: string): BoardLayout | null => {
  try { return JSON.parse(localStorage.getItem(cacheKey(folderKey)) || 'null'); } catch { return null; }
};
const writeCache = (folderKey: string, layout: BoardLayout) => {
  try { localStorage.setItem(cacheKey(folderKey), JSON.stringify(layout)); } catch { /* saved with the account anyway */ }
};
// Set while a change has not reached the account yet, so the next visit sends it instead of loading an older layout.
const unsavedKey = (folderKey: string) => `filebox-board-unsaved-${folderKey}`;
const markUnsaved = (folderKey: string, unsaved: boolean) => {
  try {
    if (unsaved) localStorage.setItem(unsavedKey(folderKey), '1');
    else localStorage.removeItem(unsavedKey(folderKey));
  } catch { /* nothing more to do */ }
};
const hasUnsaved = (folderKey: string) => {
  try { return localStorage.getItem(unsavedKey(folderKey)) === '1'; } catch { return false; }
};
const FileBoard: React.FC<FileBoardProps> = ({ folderKey, entries }) => {
  const [layout, setLayout] = useState<BoardLayout>(() => readCache(folderKey) || { items: {}, zones: [] });
  const [status, setStatus] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The change waiting to be sent (which folder, and the layout).
  const pending = useRef<{ folderKey: string; layout: BoardLayout } | null>(null);

  const send = useCallback((key: string, next: BoardLayout) => {
    boardsAPI.save(key, next)
      .then(() => {
        // A newer change may already be waiting; it stays marked until it is sent too.
        if (!pending.current || pending.current.folderKey !== key) markUnsaved(key, false);
        setStatus('');
      })
      .catch(() => setStatus('Saved in this browser only (could not reach File Box). It will be sent next time.'));
  }, []);

  // Send a waiting change now (when leaving the board or the folder), instead of dropping it.
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const waiting = pending.current;
    pending.current = null;
    if (waiting) send(waiting.folderKey, waiting.layout);
  }, [send]);

  // The account's layout for this folder, unless this browser has newer changes it has not sent yet.
  useEffect(() => {
    let cancelled = false;
    const cached = readCache(folderKey);
    setLayout(cached || { items: {}, zones: [] });
    if (cached && hasUnsaved(folderKey)) {
      send(folderKey, cached);
    } else {
      boardsAPI.get(folderKey)
        .then(saved => { if (!cancelled && !hasUnsaved(folderKey)) { setLayout(saved); writeCache(folderKey, saved); } })
        .catch(() => { /* keep the layout saved in this browser */ });
    }
    return () => { cancelled = true; flush(); };
  }, [folderKey, send, flush]);

  // Closing or reloading the tab: send what is waiting.
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [flush]);

  const commit = useCallback((next: BoardLayout) => {
    setLayout(next);
    writeCache(folderKey, next);
    markUnsaved(folderKey, true);
    pending.current = { folderKey, layout: next };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [folderKey, flush]);

  return <BoardCanvas boardKey={folderKey} layout={layout} entries={entries} onCommit={commit} status={status} />;
};

export default FileBoard;
