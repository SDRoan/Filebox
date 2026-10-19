import { BRAND_PALETTE } from './brandPalette';

/**
 * File Box's accent color. Every brand color in the stylesheets is a variable (--fb-g-<hex>) whose
 * default is the original green. Choosing an accent recolors all of them at once: each keeps its own
 * lightness (so light backgrounds stay light and dark text stays readable) and takes the accent's hue,
 * with saturation scaled by how colorful the accent is. A gray accent gives a neutral theme.
 */

export const DEFAULT_ACCENT = '#3f6543';
const STORAGE_KEY = 'filebox-accent';

type HSL = { h: number; s: number; l: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function hexToHsl(hex: string): HSL {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToHex({ h, s, l }: HSL): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);

const BASE = hexToHsl(DEFAULT_ACCENT);

// The darkest and lightest accent the main color may take: white text stays readable on buttons, and
// dark text stays readable on tinted backgrounds. Lighter or darker picks are shifted into this range.
export const ACCENT_LIGHTNESS = { min: 0.2, max: 0.5 };
const PALE_MAX_SATURATION = 0.55;

/** Lightness the main brand color takes for an accent (after keeping it readable). */
export const usableLightness = (accent: string) => clamp(hexToHsl(accent).l, ACCENT_LIGHTNESS.min, ACCENT_LIGHTNESS.max);

/**
 * The color a brand shade becomes for an accent (exposed for previews and tests). Every shade takes the
 * accent's hue; saturation scales with how colorful the accent is; lightness is remapped so the main
 * brand color becomes the accent itself while lighter and darker shades keep their order and spacing.
 */
export function shadeFor(original: string, accent: string): string {
  const target = hexToHsl(accent);
  const shade = hexToHsl(`#${original}`);
  const strength = target.s / BASE.s;
  const mainL = usableLightness(accent);
  const l = shade.l <= BASE.l
    ? shade.l * (mainL / BASE.l)
    : mainL + (shade.l - BASE.l) * ((1 - mainL) / (1 - BASE.l));
  // Pale backgrounds stay soft even for a vivid accent; everything else follows the accent fully.
  const maxS = l > 0.85 ? PALE_MAX_SATURATION : 1;
  return hslToHex({ h: target.h, s: clamp(shade.s * strength, 0, maxS), l: clamp(l, 0, 1) });
}

/** Recolor File Box for an accent (or back to green for the default / no accent). */
export function applyAccent(accent?: string | null) {
  const root = document.documentElement;
  if (!isHexColor(accent) || accent.toLowerCase() === DEFAULT_ACCENT) {
    BRAND_PALETTE.forEach(hex => root.style.removeProperty(`--fb-g-${hex}`));
    return;
  }
  BRAND_PALETTE.forEach(hex => root.style.setProperty(`--fb-g-${hex}`, shadeFor(hex, accent)));
}

/** The accent saved in this browser (applied before the page appears, so there is no green flash). */
export function storedAccent(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isHexColor(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberAccent(accent: string | null) {
  try {
    if (accent && accent.toLowerCase() !== DEFAULT_ACCENT) localStorage.setItem(STORAGE_KEY, accent);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Saved with the account anyway; this only avoids a flash of green on load.
  }
}
