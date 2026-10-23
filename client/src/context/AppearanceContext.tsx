import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { preferencesAPI } from '../services/api';
import { useAuth } from './AuthContext';
import {
  Appearance, BackgroundLayout, HomeLayout, SidebarLayout, applyAppearance, applyBackgroundImage, isBackgroundImage,
  rememberAppearance, rememberBackgroundImage, sanitizeAppearance, storedAppearance, storedBackgroundImage,
} from '../theme/appearance';

type SaveStatus = '' | 'saving' | 'saved' | 'local';

interface AppearanceContextType {
  appearance: Appearance;
  update: (patch: Partial<Appearance>) => void;
  updateSidebar: (patch: Partial<SidebarLayout>) => void;
  updateHome: (patch: Partial<HomeLayout>) => void;
  updateBackground: (patch: Partial<BackgroundLayout>) => void;
  backgroundImage: string | null;
  setBackgroundImage: (image: string | null) => Promise<void>;
  replace: (next: Appearance) => void;
  status: SaveStatus;
}

const AppearanceContext = createContext<AppearanceContextType | undefined>(undefined);

const SAVE_DELAY_MS = 600;
// Set while a change has not reached the account yet (e.g. the tab closed before it was sent), so the
// next visit sends it instead of loading the older look from the account.
const UNSAVED_KEY = 'filebox-appearance-unsaved';
const markUnsaved = (unsaved: boolean) => {
  try {
    if (unsaved) localStorage.setItem(UNSAVED_KEY, '1');
    else localStorage.removeItem(UNSAVED_KEY);
  } catch { /* nothing more to do */ }
};
const hasUnsaved = () => {
  try { return localStorage.getItem(UNSAVED_KEY) === '1'; } catch { return false; }
};

export const AppearanceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [appearance, setAppearance] = useState<Appearance>(storedAppearance);
  const [status, setStatus] = useState<SaveStatus>('');
  const [backgroundImage, setImage] = useState<string | null>(storedBackgroundImage);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changedHere = useRef(false);
  // Latest look, so several quick changes (e.g. dragging a slider) build on each other.
  const latest = useRef(appearance);
  latest.current = appearance;

  useEffect(() => { applyAppearance(appearance); }, [appearance]);
  useEffect(() => { applyBackgroundImage(backgroundImage); }, [backgroundImage]);

  const send = useCallback((next: Appearance) => {
    preferencesAPI.setAppearance(next)
      .then(() => {
        // A newer change may already be waiting; it stays marked until it is sent too.
        if (latest.current === next) markUnsaved(false);
        setStatus('saved');
      })
      .catch(() => setStatus('local'));
  }, []);

  // The account's look, so it follows the person to other browsers (unless they already changed it here).
  useEffect(() => {
    if (!user) return;
    if (hasUnsaved()) { send(latest.current); return; }
    preferencesAPI.get()
      .then(({ appearance: saved }) => {
        if (changedHere.current) return;
        // No saved look on the account means File Box's own look.
        const next = sanitizeAppearance(saved);
        rememberAppearance(next);
        setAppearance(next);
      })
      .catch(() => { /* keep the look saved in this browser */ });
    // The uploaded background picture is kept apart (it is much larger than the rest).
    preferencesAPI.getBackground()
      .then(({ image }) => {
        const next = isBackgroundImage(image) ? image : null;
        rememberBackgroundImage(next);
        setImage(next);
      })
      .catch(() => { /* keep the picture saved in this browser */ });
  }, [user, send]);

  const setBackgroundImage = useCallback(async (image: string | null) => {
    setImage(image);
    rememberBackgroundImage(image);
    await preferencesAPI.setBackground(image);
  }, []);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const commit = useCallback((next: Appearance) => {
    changedHere.current = true;
    rememberAppearance(next);
    markUnsaved(true);
    setStatus('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => send(next), SAVE_DELAY_MS);
  }, [send]);

  const change = useCallback((make: (current: Appearance) => Appearance) => {
    const next = sanitizeAppearance(make(latest.current));
    latest.current = next;
    setAppearance(next);
    commit(next);
  }, [commit]);

  const value: AppearanceContextType = {
    appearance,
    status,
    update: (patch) => change(current => ({ ...current, ...patch })),
    updateSidebar: (patch) => change(current => ({ ...current, sidebar: { ...current.sidebar, ...patch } })),
    updateHome: (patch) => change(current => ({ ...current, home: { ...current.home, ...patch } })),
    updateBackground: (patch) => change(current => ({ ...current, background: { ...current.background, ...patch } })),
    backgroundImage,
    setBackgroundImage,
    replace: (next) => change(() => next),
  };

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
};

export const useAppearance = () => {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error('useAppearance must be used inside AppearanceProvider');
  return context;
};
