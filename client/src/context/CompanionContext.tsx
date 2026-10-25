import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { companionAPI, CompanionProfile } from '../services/api';
import { useAuth } from './AuthContext';

/**
 * File Box AI as a companion, shared by the side panel and the File Box AI page: its profile (name,
 * tone, proactivity, memories), whether the panel is open, and where the person is in File Box.
 */

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
  // Ask File Box AI something from outside the chat (the panel's "what am I looking at?" buttons).
  ask: (text: string, fileId?: string) => void;
  setAskHandler: (handler: ((text: string, fileId?: string) => void) | null) => void;
}

const DEFAULT_PROFILE: CompanionProfile = { name: '', tone: 'friendly', proactivity: 'balanced', memoryOn: true, screenAware: true, memories: [] };
const OPEN_KEY = 'filebox-companion-open';

const CompanionContext = createContext<CompanionContextType | undefined>(undefined);

export const CompanionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [profile, setProfile] = useState<CompanionProfile>(DEFAULT_PROFILE);
  const [open, setOpenState] = useState(() => { try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const [pageContext, setPageContext] = useState('');
  const askHandler = useRef<((text: string, fileId?: string) => void) | null>(null);
  const setAskHandler = useCallback((handler: ((text: string, fileId?: string) => void) | null) => { askHandler.current = handler; }, []);
  const ask = useCallback((text: string, fileId?: string) => askHandler.current?.(text, fileId), []);

  const refresh = useCallback(() => {
    companionAPI.get().then(setProfile).catch(() => { /* keep the defaults */ });
  }, []);
  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try { sessionStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* only for this visit */ }
  }, []);

  return (
    <CompanionContext.Provider value={{ profile, name: profile.name.trim() || 'File Box AI', refresh, setProfile, open, setOpen, pageContext, setPageContext, ask, setAskHandler }}>
      {children}
    </CompanionContext.Provider>
  );
};

export const useCompanion = () => {
  const context = useContext(CompanionContext);
  if (!context) throw new Error('useCompanion must be used inside CompanionProvider');
  return context;
};
