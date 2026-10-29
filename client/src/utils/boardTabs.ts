/**
 * Boards tabs: the emoji and accent colours a tab can have, and which tab is open in this browser session.
 * The colours only tint a small bar and the active tab's underline (never text); each is at least 3:1
 * against the tab background.
 */

export const TAB_COLORS: Record<string, { label: string; hex: string }> = {
  sage: { label: 'Sage', hex: '#5b8a55' },
  sky: { label: 'Sky', hex: '#2f7cc0' },
  lavender: { label: 'Lavender', hex: '#7a62c7' },
  rose: { label: 'Rose', hex: '#c2456a' },
  amber: { label: 'Amber', hex: '#a8730c' },
  mint: { label: 'Mint', hex: '#23896d' },
  coral: { label: 'Coral', hex: '#cc5232' },
  slate: { label: 'Slate', hex: '#5a6a80' },
  sand: { label: 'Sand', hex: '#8f7748' },
  teal: { label: 'Teal', hex: '#13777d' },
};

export const tabAccent = (color?: string) => (color && TAB_COLORS[color] ? TAB_COLORS[color].hex : '');

export const TAB_EMOJI: Array<[string, string]> = [
  ['💼', 'Briefcase'], ['📚', 'Books'], ['🏠', 'House'], ['💰', 'Money bag'], ['🧾', 'Receipt'], ['✈️', 'Airplane'], ['🩺', 'Stethoscope'], ['🎓', 'Graduation cap'],
  ['🛒', 'Shopping cart'], ['🎨', 'Palette'], ['📷', 'Camera'], ['🎵', 'Music note'], ['🧪', 'Test tube'], ['💡', 'Light bulb'], ['📌', 'Pushpin'], ['⭐', 'Star'],
  ['🗂️', 'Dividers'], ['📅', 'Calendar'], ['🧠', 'Brain'], ['🏃', 'Runner'], ['🍳', 'Cooking'], ['🚗', 'Car'], ['🌱', 'Seedling'], ['🐾', 'Paw prints'],
  ['⚖️', 'Scales'], ['🔧', 'Wrench'], ['🎮', 'Game controller'], ['❤️', 'Heart'], ['🌍', 'Globe'], ['📝', 'Memo'], ['🎯', 'Target'], ['🧳', 'Luggage'],
];

/** Exactly one emoji (the same rule the server uses), trimmed; null if it is not. */
export function oneEmoji(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 16) return null;
  const Segmenter = (Intl as any).Segmenter;
  const parts: string[] = Segmenter ? Array.from(new Segmenter('en', { granularity: 'grapheme' }).segment(text), (s: any) => s.segment) : Array.from(text);
  return parts.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(parts[0]) ? parts[0] : null;
}

// Which tab is open: kept for this browser session only, so a reload or coming back returns to it, while
// a fresh visit opens the default tab (which is saved with the account).
const openTabKey = (userId?: string) => `filebox-boards-open-tab-${userId || 'me'}`;
export const readOpenTab = (userId?: string) => { try { return sessionStorage.getItem(openTabKey(userId)) || ''; } catch { return ''; } };
export const writeOpenTab = (userId: string | undefined, tabId: string) => {
  try {
    sessionStorage.setItem(openTabKey(userId), tabId);
    // Before Phase 4 the last tab was kept for good in localStorage; that would override the default.
    localStorage.removeItem(`filebox-boards-last-tab-${userId || 'me'}`);
  } catch { /* only a convenience */ }
};
