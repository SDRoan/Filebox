import { DEFAULT_ACCENT, hexToHsl, isHexColor } from './accent';
import { customFontStack, isCustomFontChoice, loadGoogleFont, parseFontChoice } from './fonts';

/**
 * Everything a person can change about how File Box looks (Settings > Customize), apart from the accent
 * color, which keeps its own setting (theme/accent.ts). Applied as CSS variables and classes on <html>,
 * so it reaches every page. Saved in this browser (no flash on load) and with the account.
 */

export type FontId = 'system' | 'humanist' | 'rounded' | 'georgia' | 'book' | 'mono' | 'condensed';
// A File Box font, or any Google / installed font as 'google:<Family>' or 'local:<Family>' (theme/fonts.ts).
export type FontChoice = FontId | string;

export const FONTS: Record<FontId, { label: string; stack: string }> = {
  system: { label: 'System sans', stack: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', sans-serif" },
  humanist: { label: 'Humanist', stack: "'Avenir Next', Avenir, 'Segoe UI', 'Helvetica Neue', sans-serif" },
  rounded: { label: 'Rounded', stack: "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', 'Nunito', system-ui, sans-serif" },
  georgia: { label: 'Georgia serif', stack: "Georgia, 'Times New Roman', serif" },
  book: { label: 'Book serif', stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
  mono: { label: 'Monospace', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
  condensed: { label: 'Condensed', stack: "'Avenir Next Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif-condensed, sans-serif" },
};

export interface SidebarLayout {
  position: 'left' | 'right';
  style: 'full' | 'icons';
  showSectionTitles: boolean;
  hidden: string[];
  order: string[];
  labels: Record<string, string>;
  sectionTitles: Record<string, string>;
}

export interface HomeLayout {
  title: string;
  showGreeting: boolean;
  showShortcuts: boolean;
  showDay: boolean;
  showSuggestions: boolean;
}

export interface BackgroundLayout {
  kind: 'none' | 'preset' | 'image' | 'url';
  preset: string;
  url: string;
  fade: number;
  blur: number;
  behindSidebar: boolean;
  // Sidebar and top bar colors chosen to go with the background (theme/palette.ts).
  matchColors: boolean;
  matchStyle: 'soft' | 'colorful' | 'neutral';
  matchAccent: boolean;
  // Which background (and mode and style) the colors were last matched to, so they are not redone needlessly.
  matchedFor: string;
}

// Ready-made backgrounds (Settings > Customize > Background).
export const BACKGROUND_PRESETS: Array<{ id: string; name: string; css: string }> = [
  { id: 'meadow', name: 'Meadow', css: 'linear-gradient(135deg, #e8f3df 0%, #cfe6d3 45%, #f6efd9 100%)' },
  { id: 'dawn', name: 'Dawn', css: 'linear-gradient(160deg, #ffe8d6 0%, #f9c9c4 45%, #c9c6f2 100%)' },
  { id: 'ocean', name: 'Ocean', css: 'linear-gradient(160deg, #dff3fb 0%, #a9d6ea 50%, #6fa7c8 100%)' },
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(160deg, #ffd29d 0%, #ff9a8b 50%, #a26bb0 100%)' },
  { id: 'lavender', name: 'Lavender', css: 'linear-gradient(135deg, #f3e9ff 0%, #dcd3f7 50%, #f8dcef 100%)' },
  { id: 'aurora', name: 'Aurora', css: 'radial-gradient(at 20% 20%, #b5f0d6 0, transparent 50%), radial-gradient(at 80% 10%, #b9d4ff 0, transparent 50%), radial-gradient(at 70% 80%, #f6c6ea 0, transparent 55%), #f4f6fb' },
  { id: 'night', name: 'Night sky', css: 'radial-gradient(at 70% 20%, #3b4a8a 0, transparent 55%), radial-gradient(at 20% 80%, #2a6170 0, transparent 50%), #121626' },
  { id: 'sand', name: 'Sand', css: 'linear-gradient(180deg, #f8f1e3 0%, #ecdcc0 100%)' },
  { id: 'dots', name: 'Dots', css: 'radial-gradient(#00000022 1.2px, transparent 1.4px) 0 0 / 18px 18px, #f7f7f2' },
  { id: 'grid', name: 'Grid', css: 'linear-gradient(#0000000f 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, #0000000f 1px, transparent 1px) 0 0 / 28px 28px, #fbfbf8' },
];

export interface Appearance {
  mode: 'light' | 'dark';
  bodyFont: FontChoice;
  headingFont: FontChoice;
  textScale: number;
  roundness: number;
  pageColor: string | null;
  surfaceColor: string | null;
  sidebarColor: string | null;
  headerColor: string | null;
  brandName: string;
  reduceMotion: boolean;
  sidebar: SidebarLayout;
  home: HomeLayout;
  background: BackgroundLayout;
  customCss: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'light',
  bodyFont: 'system',
  headingFont: 'georgia',
  textScale: 1,
  roundness: 1,
  pageColor: null,
  surfaceColor: null,
  sidebarColor: null,
  headerColor: null,
  brandName: '',
  reduceMotion: false,
  sidebar: { position: 'left', style: 'full', showSectionTitles: true, hidden: [], order: [], labels: {}, sectionTitles: {} },
  home: { title: '', showGreeting: true, showShortcuts: true, showDay: true, showSuggestions: true },
  background: { kind: 'none', preset: '', url: '', fade: 0.55, blur: 0, behindSidebar: false, matchColors: true, matchStyle: 'soft', matchAccent: false, matchedFor: '' },
  customCss: '',
};

export const TEXT_SCALE = { min: 0.85, max: 1.3 };
export const ROUNDNESS = { min: 0, max: 2.5 };
export const MAX_CUSTOM_CSS = 20000;
export const BACKGROUND_FADE = { min: 0, max: 0.95 };
export const BACKGROUND_BLUR = { min: 0, max: 24 };
const IMAGE_URL = /^https?:\/\/[^\s"'()\\<>]{1,2000}$/;
export const isImageUrl = (value: string) => IMAGE_URL.test(value);
const MAX_LABEL = 40;
const STORAGE_KEY = 'filebox-appearance';

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  accent: string;
  appearance: Partial<Appearance>;
}

// Whole looks in one click. Each starts from the defaults, so layout choices (sidebar, Home) are kept.
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'filebox', name: 'File Box', description: 'The original: calm green, serif headings.', accent: DEFAULT_ACCENT, appearance: {} },
  { id: 'midnight', name: 'Midnight', description: 'Dark, with a cool blue accent.', accent: '#2f5d8a', appearance: { mode: 'dark', headingFont: 'system' } },
  { id: 'paper', name: 'Paper', description: 'Warm page, book serif, sharp corners.', accent: '#7a5a3a', appearance: { bodyFont: 'book', headingFont: 'book', roundness: 0.2, pageColor: '#fbf7ef', sidebarColor: '#f3ecdf', surfaceColor: '#fffdf8' } },
  { id: 'playful', name: 'Playful', description: 'Rounded type and extra-soft corners.', accent: '#6a4a7d', appearance: { bodyFont: 'rounded', headingFont: 'rounded', roundness: 2.2 } },
  { id: 'terminal', name: 'Terminal', description: 'Dark monospace, square edges.', accent: '#3e7a3b', appearance: { mode: 'dark', bodyFont: 'mono', headingFont: 'mono', roundness: 0, textScale: 0.95 } },
  { id: 'studio', name: 'Studio', description: 'Neutral graphite, clean sans headings.', accent: '#4a4f57', appearance: { headingFont: 'humanist', pageColor: '#ffffff', sidebarColor: '#f4f5f7' } },
  { id: 'large', name: 'Easy reading', description: 'Bigger text, calmer motion.', accent: '#2f6f6a', appearance: { textScale: 1.18, reduceMotion: true, headingFont: 'humanist' } },
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const text = (value: unknown, max = MAX_LABEL) => (typeof value === 'string' ? value.slice(0, max) : '');
const color = (value: unknown) => (isHexColor(value) ? value.toLowerCase() : null);
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number, range: { min: number; max: number }) =>
  (typeof value === 'number' && Number.isFinite(value) ? clamp(value, range.min, range.max) : fallback);
const font = (value: unknown, fallback: FontChoice): FontChoice =>
  (typeof value === 'string' && (value in FONTS || isCustomFontChoice(value)) ? value : fallback);

export const isFileBoxFont = (choice: FontChoice): choice is FontId => choice in FONTS;

/** The CSS font-family for a choice. */
export function fontStack(choice: FontChoice): string {
  if (isFileBoxFont(choice)) return FONTS[choice].stack;
  const custom = parseFontChoice(choice);
  return custom ? customFontStack(custom.source, custom.family) : FONTS.system.stack;
}

/** The name people see for a choice. */
export function fontName(choice: FontChoice): string {
  if (isFileBoxFont(choice)) return FONTS[choice].label;
  return parseFontChoice(choice)?.family || FONTS.system.label;
}

/** Make sure a chosen Google font is loaded. */
export function loadFontChoice(choice: FontChoice) {
  const custom = parseFontChoice(choice);
  if (custom?.source === 'google') loadGoogleFont(custom.family);
}
const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 50) : []);
const labels = (value: unknown) => {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).slice(0, 50).forEach(([key, v]) => { const t = text(v); if (t.trim()) out[key] = t; });
  }
  return out;
};

/** A complete, safe Appearance from anything (saved JSON, an imported file, the server). */
export function sanitizeAppearance(input: unknown): Appearance {
  const d = DEFAULT_APPEARANCE;
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const s = (a.sidebar && typeof a.sidebar === 'object' ? a.sidebar : {}) as Record<string, unknown>;
  const h = (a.home && typeof a.home === 'object' ? a.home : {}) as Record<string, unknown>;
  const bg = (a.background && typeof a.background === 'object' ? a.background : {}) as Record<string, unknown>;
  return {
    mode: a.mode === 'dark' ? 'dark' : 'light',
    bodyFont: font(a.bodyFont, d.bodyFont),
    headingFont: font(a.headingFont, d.headingFont),
    textScale: num(a.textScale, d.textScale, TEXT_SCALE),
    roundness: num(a.roundness, d.roundness, ROUNDNESS),
    pageColor: color(a.pageColor),
    surfaceColor: color(a.surfaceColor),
    sidebarColor: color(a.sidebarColor),
    headerColor: color(a.headerColor),
    brandName: text(a.brandName, 30),
    reduceMotion: bool(a.reduceMotion, d.reduceMotion),
    sidebar: {
      position: s.position === 'right' ? 'right' : 'left',
      style: s.style === 'icons' ? 'icons' : 'full',
      showSectionTitles: bool(s.showSectionTitles, d.sidebar.showSectionTitles),
      hidden: ids(s.hidden),
      order: ids(s.order),
      labels: labels(s.labels),
      sectionTitles: labels(s.sectionTitles),
    },
    home: {
      title: text(h.title, 60),
      showGreeting: bool(h.showGreeting, d.home.showGreeting),
      showShortcuts: bool(h.showShortcuts, d.home.showShortcuts),
      showDay: bool(h.showDay, d.home.showDay),
      showSuggestions: bool(h.showSuggestions, d.home.showSuggestions),
    },
    background: {
      kind: (['preset', 'image', 'url'] as const).find(kind => kind === bg.kind) || 'none',
      preset: BACKGROUND_PRESETS.some(p => p.id === bg.preset) ? bg.preset as string : '',
      url: typeof bg.url === 'string' && isImageUrl(bg.url) ? bg.url : '',
      fade: num(bg.fade, d.background.fade, BACKGROUND_FADE),
      blur: num(bg.blur, d.background.blur, BACKGROUND_BLUR),
      behindSidebar: bool(bg.behindSidebar, d.background.behindSidebar),
      matchColors: bool(bg.matchColors, d.background.matchColors),
      matchStyle: (['soft', 'colorful', 'neutral'] as const).find(style => style === bg.matchStyle) || d.background.matchStyle,
      matchAccent: bool(bg.matchAccent, d.background.matchAccent),
      matchedFor: text(bg.matchedFor, 200),
    },
    customCss: text(a.customCss, MAX_CUSTOM_CSS),
  };
}

/** Starting from the defaults, the look of a preset (keeping the person's sidebar, Home and CSS). */
export function presetAppearance(preset: ThemePreset, current: Appearance): Appearance {
  return sanitizeAppearance({
    ...DEFAULT_APPEARANCE,
    ...preset.appearance,
    brandName: current.brandName,
    sidebar: current.sidebar,
    home: current.home,
    background: current.background,
    customCss: current.customCss,
  });
}

export const isDark = (hex: string) => hexToHsl(hex).l < 0.45;

// Dark mode turns the whole page around with invert(1) hue-rotate(180deg) (see appearance.css), so chosen
// colors are put through the opposite first and come out as picked. hue-rotate(180deg) undoes itself.
const HUE_ROTATE_180 = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
];
const rgbOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const hexOf = (rgb: number[]) => `#${rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
const rotate = (rgb: number[]) => HUE_ROTATE_180.map(row => row.reduce((sum, weight, i) => sum + weight * rgb[i], 0));

/** How a color of File Box's light look appears in dark mode (for previews). */
export const darkModeLook = (hex: string) => hexOf(rotate(rgbOf(hex).map(v => 1 - v)));

export function darkModeValue(hex: string): string {
  return hexOf(rotate(rgbOf(hex)).map(v => 1 - v));
}

const CUSTOM_CSS_ID = 'filebox-custom-css';
const CHOSEN_COLORS_ID = 'filebox-chosen-colors';

// Opening File Box with ?safe in the address skips custom CSS, in case it ever hides what is needed to undo it.
export const customCssPaused = () => new URLSearchParams(window.location.search).has('safe');

/** Show File Box with these choices. */
export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  const dark = appearance.mode === 'dark';
  const setVar = (name: string, value: string | null) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
  const shown = (hex: string | null) => (hex && dark ? darkModeValue(hex) : hex);

  loadFontChoice(appearance.bodyFont);
  loadFontChoice(appearance.headingFont);
  setVar('--font-sans', appearance.bodyFont === DEFAULT_APPEARANCE.bodyFont ? null : fontStack(appearance.bodyFont));
  setVar('--fb-heading-font', appearance.headingFont === DEFAULT_APPEARANCE.headingFont ? null : fontStack(appearance.headingFont));
  setVar('--fb-zoom', appearance.textScale === 1 ? null : String(appearance.textScale));
  setVar('--fb-radius-scale', appearance.roundness === 1 ? null : String(appearance.roundness));
  setVar('--fb-page-bg', shown(appearance.pageColor));
  setVar('--fb-surface', shown(appearance.surfaceColor));
  setVar('--fb-sidebar-bg', shown(appearance.sidebarColor));
  setVar('--fb-header-bg', shown(appearance.headerColor));
  root.classList.toggle('fb-dark', dark);
  root.classList.toggle('fb-reduce-motion', appearance.reduceMotion);
  root.classList.toggle('fb-custom-body-font', appearance.bodyFont !== DEFAULT_APPEARANCE.bodyFont);

  const bg = appearance.background;
  const backdrop = bg.kind === 'preset' ? BACKGROUND_PRESETS.find(p => p.id === bg.preset)?.css
    : bg.kind === 'url' && bg.url ? `url("${bg.url}") center / cover no-repeat`
      : bg.kind === 'image' ? 'var(--fb-bg-upload, none) center / cover no-repeat' : undefined;
  setVar('--fb-bg-image', backdrop || null);
  setVar('--fb-bg-fade', backdrop ? `${Math.round(bg.fade * 100)}%` : null);
  setVar('--fb-bg-header', backdrop ? `${Math.round(Math.min(1, bg.fade + 0.25) * 100)}%` : null);
  setVar('--fb-bg-blur', backdrop && bg.blur ? `${bg.blur}px` : null);
  root.classList.toggle('fb-has-backdrop', !!backdrop);
  root.classList.toggle('fb-backdrop-sidebar', !!backdrop && bg.behindSidebar);

  let style = document.getElementById(CUSTOM_CSS_ID) as HTMLStyleElement | null;
  if (appearance.customCss.trim() && !customCssPaused()) {
    if (!style) {
      style = document.createElement('style');
      style.id = CUSTOM_CSS_ID;
    }
    // Always last, so it wins over File Box's own styles of the same specificity.
    document.head.appendChild(style);
    if (style.textContent !== appearance.customCss) style.textContent = appearance.customCss;
  } else {
    style?.remove();
  }

  // A top bar color picked directly wins over custom CSS (even !important), so it is placed after it.
  let chosen = document.getElementById(CHOSEN_COLORS_ID) as HTMLStyleElement | null;
  const header = shown(appearance.headerColor);
  if (header) {
    if (!chosen) {
      chosen = document.createElement('style');
      chosen.id = CHOSEN_COLORS_ID;
    }
    document.head.appendChild(chosen);
    chosen.textContent = `.dashboard .dashboard-header { background: ${header} !important; }`;
  } else {
    chosen?.remove();
  }
}

const BACKGROUND_IMAGE_KEY = 'filebox-background-image';
export const isBackgroundImage = (value: unknown): value is string =>
  typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);

/** The uploaded background picture (Settings > Customize > Background > Your picture). */
export function applyBackgroundImage(image: string | null) {
  const root = document.documentElement;
  if (image) root.style.setProperty('--fb-bg-upload', `url("${image}")`);
  else root.style.removeProperty('--fb-bg-upload');
}

export function storedBackgroundImage(): string | null {
  try {
    const value = localStorage.getItem(BACKGROUND_IMAGE_KEY);
    return isBackgroundImage(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberBackgroundImage(image: string | null) {
  try {
    if (image) localStorage.setItem(BACKGROUND_IMAGE_KEY, image);
    else localStorage.removeItem(BACKGROUND_IMAGE_KEY);
  } catch {
    // Too large for this browser's storage: it is still saved with the account.
  }
}

/** Shrink a picture to at most 2560 px wide or tall, as a JPEG, so it loads fast and is easy to save. */
export async function prepareBackgroundImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.75, 0.6, 0.45]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length < 3 * 1024 * 1024) return data;
  }
  throw new Error('This picture is too large even after shrinking it.');
}

export function storedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return sanitizeAppearance(value ? JSON.parse(value) : null);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function rememberAppearance(appearance: Appearance) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Saved with the account anyway; this only avoids a flash of the default look on load.
  }
}
