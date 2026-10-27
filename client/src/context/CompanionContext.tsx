import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { companionAPI, CompanionProfile } from '../services/api';
import { useAuth } from './AuthContext';

/**
 * File Box AI as a companion, shared by the side panel and the File Box AI page: its profile (name,
 * tone, proactivity, memories), whether the panel is open, and where the person is in File Box.
 */

// page/totalPages: the PDF page most in view in File Box's PDF viewer.
export interface FocusFile { id: string; name: string; mimeType?: string; page?: number; totalPages?: number }
export interface FocusItem { id: string; name: string; type: 'file' | 'folder'; mimeType?: string }
export interface FocusFolder { id: string; name: string }

/**
 * What the person is looking at, most specific first: a file open in the preview (or the one selected
 * file), several selected items, the folder they are in, or just the page.
 */
export interface CompanionFocus {
  kind: 'file' | 'selection' | 'folder' | 'page';
  file?: FocusFile;
  selection?: FocusItem[];
  folder?: FocusFolder;
  page: string;
  // Changes whenever what is being looked at changes (for "Context changed to …").
  key: string;
}

export type AskMode = 'send' | 'prefill';
type AskHandler = (text: string, fileId?: string, mode?: AskMode) => void;

interface CompanionContextType {
  profile: CompanionProfile;
  name: string;
  refresh: () => void;
  setProfile: (profile: CompanionProfile) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  // A sentence about where the person is ("On My Files, inside the folder Taxes"), sent with questions.
  pageContext: string;
  setPageContext: (context: string) => void;
  // Ask File Box AI something from outside the chat (the panel's quick actions). 'prefill' puts the
  // words in the box for the person to finish ("Rename this to …") instead of sending them.
  ask: (text: string, fileId?: string, mode?: AskMode) => void;
  setAskHandler: (handler: AskHandler | null) => void;
  focus: CompanionFocus;
  // Reported by the screens themselves: the preview, the file browser and the page.
  showFile: (file: FocusFile) => void;
  hideFile: (id: string) => void;
  setFilePage: (id: string, page: number, total: number) => void;
  setSelection: (items: FocusItem[]) => void;
  setFolder: (folder: FocusFolder | null) => void;
  setPage: (page: string) => void;
}

const DEFAULT_PROFILE: CompanionProfile = { name: '', tone: 'friendly', proactivity: 'balanced', memoryOn: true, screenAware: true, memories: [] };
const OPEN_KEY = 'filebox-companion-open';

const CompanionContext = createContext<CompanionContextType | undefined>(undefined);

export const CompanionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [profile, setProfile] = useState<CompanionProfile>(DEFAULT_PROFILE);
  const [open, setOpenState] = useState(() => { try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const [pageContext, setPageContext] = useState('');
  const askHandler = useRef<AskHandler | null>(null);
  const setAskHandler = useCallback((handler: AskHandler | null) => { askHandler.current = handler; }, []);
  const ask = useCallback((text: string, fileId?: string, mode?: AskMode) => askHandler.current?.(text, fileId, mode), []);

  const [previewFile, setPreviewFile] = useState<FocusFile | null>(null);
  const [selection, setSelectionState] = useState<FocusItem[]>([]);
  const [folder, setFolderState] = useState<FocusFolder | null>(null);
  const [page, setPage] = useState('');
  const showFile = useCallback((file: FocusFile) => setPreviewFile(file), []);
  // Only clears if that file is still the one shown (another preview may have opened since).
  const hideFile = useCallback((id: string) => setPreviewFile(current => (current?.id === id ? null : current)), []);
  // The visible PDF page is not part of the focus key (scrolling pages is not a new context in the chat);
  // it is part of the screen fingerprint instead (companion/screen.ts).
  const setFilePage = useCallback((id: string, page: number, total: number) => setPreviewFile(current =>
    (current?.id === id && (current.page !== page || current.totalPages !== total) ? { ...current, page, totalPages: total } : current)), []);
  const setSelection = useCallback((items: FocusItem[]) => setSelectionState(current =>
    (current.map(i => i.id).join() === items.map(i => i.id).join() ? current : items)), []);
  const setFolder = useCallback((next: FocusFolder | null) => setFolderState(current =>
    (current?.id === next?.id && current?.name === next?.name ? current : next)), []);

  const focus = useMemo<CompanionFocus>(() => {
    const single = selection.length === 1 && selection[0].type === 'file' ? selection[0] : null;
    if (previewFile) return { kind: 'file', file: previewFile, folder: folder || undefined, page, key: `file:${previewFile.id}` };
    if (single) return { kind: 'file', file: { id: single.id, name: single.name, mimeType: single.mimeType }, folder: folder || undefined, page, key: `file:${single.id}` };
    if (selection.length) return { kind: 'selection', selection, folder: folder || undefined, page, key: `selection:${selection.map(i => i.id).join(',')}` };
    if (folder) return { kind: 'folder', folder, page, key: `folder:${folder.id}` };
    return { kind: 'page', page, key: `page:${page}` };
  }, [previewFile, selection, folder, page]);

  const refresh = useCallback(() => {
    companionAPI.get().then(setProfile).catch(() => { /* keep the defaults */ });
  }, []);
  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try { sessionStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* only for this visit */ }
  }, []);

  return (
    <CompanionContext.Provider value={{ profile, name: profile.name.trim() || 'File Box AI', refresh, setProfile, open, setOpen, pageContext, setPageContext, ask, setAskHandler, focus, showFile, hideFile, setFilePage, setSelection, setFolder, setPage }}>
      {children}
    </CompanionContext.Provider>
  );
};

export const useCompanion = () => {
  const context = useContext(CompanionContext);
  if (!context) throw new Error('useCompanion must be used inside CompanionProvider');
  return context;
};
