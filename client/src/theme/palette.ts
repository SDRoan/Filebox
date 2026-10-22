import { hexToHsl, hslToHex } from './accent';

/**
 * Settings > Customize > Background: read the main colors of a background and build sidebar, top bar
 * and accent colors that go with it. Every suggestion keeps text readable (contrast of at least 7:1
 * against File Box's text in the current mode).
 */

export type MatchStyle = 'soft' | 'colorful' | 'neutral';

export interface PaletteColor { hex: string; weight: number }

export interface ColorMatch {
  style: MatchStyle;
  sidebar: string;
  header: string;
  accent: string;
}

export const MATCH_STYLES: Array<{ id: MatchStyle; name: string; description: string }> = [
  { id: 'soft', name: 'Soft', description: 'A gentle tint of the main color' },
  { id: 'colorful', name: 'Colorful', description: 'Picks up the brightest color' },
  { id: 'neutral', name: 'Neutral', description: 'Barely tinted, lets the background lead' },
];

// File Box's body text in light mode, and how it appears in dark mode.
const TEXT = { light: '#2c3829', dark: '#e3e9df' };
const MIN_CONTRAST = 7;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rgbOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;

const luminance = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Move a color lighter (light mode) or darker (dark mode) until the text on it is easy to read. */
function readable(hex: string, dark: boolean): string {
  const { h, s } = hexToHsl(hex);
  let { l } = hexToHsl(hex);
  let color = hex;
  for (let i = 0; i < 60 && contrast(color, dark ? TEXT.dark : TEXT.light) < MIN_CONTRAST; i++) {
    l = clamp(l + (dark ? -0.01 : 0.01), 0, 1);
    color = hslToHex({ h, s, l });
  }
  return color;
}

/** The main colors of a list of pixels (RGB triples), most common first: a small k-means. */
function clusterColors(pixels: number[][], k = 6): PaletteColor[] {
  if (!pixels.length) return [];
  // Start from colors spread across the image's brightness range, so results are stable.
  const sorted = [...pixels].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor((i + 0.5) * sorted.length / k)].slice());
  let assignment = new Array(pixels.length).fill(0);
  for (let round = 0; round < 10; round++) {
    const current = centers;
    assignment = pixels.map(p => {
      let best = 0;
      let bestDistance = Infinity;
      current.forEach((c, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestDistance) { bestDistance = d; best = i; }
      });
      return best;
    });
    const assigned = assignment;
    centers = current.map((c, i) => {
      const members = pixels.filter((_, j) => assigned[j] === i);
      if (!members.length) return c;
      return [0, 1, 2].map(ch => members.reduce((sum, m) => sum + m[ch], 0) / members.length);
    });
  }
  const counts = centers.map((_, i) => assignment.filter(a => a === i).length);
  return centers
    .map((c, i) => ({ hex: toHex(c), weight: counts[i] / pixels.length }))
    .filter(c => c.weight > 0.01)
    .sort((a, b) => b.weight - a.weight);
}

/** Main colors of a picture (an uploaded data URL or a link). Null when the picture's site does not allow reading it. */
export async function paletteFromImage(src: string): Promise<PaletteColor[] | null> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = src;
  try {
    await image.decode();
    const size = 56;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    const pixels: number[][] = [];
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) pixels.push([data[i], data[i + 1], data[i + 2]]);
    return clusterColors(pixels);
  } catch {
    return null;
  }
}

/** Main colors of a ready-made background (the colors written in its CSS, earlier ones weigh more). */
export function paletteFromCss(css: string): PaletteColor[] {
  const hexes = Array.from(css.matchAll(/#([0-9a-fA-F]{6})(?![0-9a-fA-F])/g), m => `#${m[1].toLowerCase()}`);
  return hexes.map((hex, i) => ({ hex, weight: (hexes.length - i) / hexes.length }));
}

/** Sidebar, top bar and accent colors that go with a palette, for each style. */
export function matchColors(palette: PaletteColor[], dark: boolean): ColorMatch[] {
  if (!palette.length) return [];
  const colors = palette.map(c => ({ ...c, ...hexToHsl(c.hex) }));
  // The main color: the most common one that has some color in it (else simply the most common).
  const main = colors.find(c => c.s > 0.12 && c.l > 0.06 && c.l < 0.96) || colors[0];
  // The brightest color: colorful, not too dark or light, and not a speck.
  const vivid = [...colors].sort((a, b) =>
    (b.s * (1 - Math.abs(b.l - 0.5)) * Math.sqrt(b.weight)) - (a.s * (1 - Math.abs(a.l - 0.5)) * Math.sqrt(a.weight)))[0];

  const tint = (hue: number, saturation: number, lightLight: number, darkLight: number) =>
    readable(hslToHex({ h: hue, s: saturation, l: dark ? darkLight : lightLight }), dark);
  // Accent: the brightest color, in the range File Box keeps accents in (see theme/accent.ts).
  const accent = hslToHex({ h: vivid.h, s: clamp(Math.max(vivid.s, 0.35), 0, 0.85), l: clamp(vivid.l, 0.32, 0.45) });

  return [
    { style: 'soft', sidebar: tint(main.h, clamp(main.s * 0.5, 0.06, 0.32), 0.93, 0.17), header: tint(main.h, clamp(main.s * 0.4, 0.05, 0.28), 0.965, 0.13), accent },
    { style: 'colorful', sidebar: tint(vivid.h, clamp(vivid.s * 0.75, 0.22, 0.55), 0.88, 0.22), header: tint(main.h, clamp(main.s * 0.6, 0.12, 0.4), 0.94, 0.16), accent },
    { style: 'neutral', sidebar: tint(main.h, 0.07, 0.95, 0.14), header: tint(main.h, 0.05, 0.975, 0.11), accent },
  ];
}
