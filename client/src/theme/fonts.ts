/**
 * Fonts for Settings > Customize. A font choice is one of:
 *   - a File Box font id ('system', 'georgia', …; see FONTS in appearance.ts)
 *   - 'google:<Family>'  a Google Fonts family, loaded from fonts.googleapis.com when used
 *   - 'local:<Family>'   a font installed on this computer
 */

export type FontCategory = 'sans' | 'serif' | 'display' | 'handwriting' | 'mono';

export const CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: 'Sans serif', serif: 'Serif', display: 'Display', handwriting: 'Handwriting', mono: 'Monospace',
};

const FALLBACK: Record<FontCategory, string> = {
  sans: 'system-ui, sans-serif', serif: 'Georgia, serif', display: 'system-ui, sans-serif', handwriting: 'cursive', mono: 'ui-monospace, monospace',
};

// Popular Google Fonts families. Any other Google font can be typed by name.
export const GOOGLE_FONTS: Array<[string, FontCategory]> = [
  ['Inter', 'sans'], ['Roboto', 'sans'], ['Open Sans', 'sans'], ['Lato', 'sans'], ['Montserrat', 'sans'], ['Poppins', 'sans'],
  ['Source Sans 3', 'sans'], ['Nunito', 'sans'], ['Nunito Sans', 'sans'], ['Raleway', 'sans'], ['Work Sans', 'sans'], ['Rubik', 'sans'],
  ['Noto Sans', 'sans'], ['Ubuntu', 'sans'], ['Mulish', 'sans'], ['Manrope', 'sans'], ['DM Sans', 'sans'], ['Plus Jakarta Sans', 'sans'],
  ['Outfit', 'sans'], ['Figtree', 'sans'], ['Karla', 'sans'], ['Barlow', 'sans'], ['Fira Sans', 'sans'], ['IBM Plex Sans', 'sans'],
  ['Quicksand', 'sans'], ['Josefin Sans', 'sans'], ['Cabin', 'sans'], ['Hind', 'sans'], ['Heebo', 'sans'], ['Lexend', 'sans'],
  ['Sora', 'sans'], ['Space Grotesk', 'sans'], ['Urbanist', 'sans'], ['Red Hat Display', 'sans'], ['Albert Sans', 'sans'], ['Archivo', 'sans'],
  ['Public Sans', 'sans'], ['Be Vietnam Pro', 'sans'], ['Onest', 'sans'], ['Geologica', 'sans'], ['Kanit', 'sans'], ['Exo 2', 'sans'],
  ['Titillium Web', 'sans'], ['Oxygen', 'sans'], ['Assistant', 'sans'], ['Varela Round', 'sans'], ['M PLUS Rounded 1c', 'sans'], ['Atkinson Hyperlegible', 'sans'],
  ['Merriweather', 'serif'], ['Playfair Display', 'serif'], ['Lora', 'serif'], ['PT Serif', 'serif'], ['Noto Serif', 'serif'], ['Libre Baskerville', 'serif'],
  ['EB Garamond', 'serif'], ['Cormorant Garamond', 'serif'], ['Crimson Text', 'serif'], ['Source Serif 4', 'serif'], ['Bitter', 'serif'], ['Roboto Slab', 'serif'],
  ['Zilla Slab', 'serif'], ['Arvo', 'serif'], ['DM Serif Display', 'serif'], ['Fraunces', 'serif'], ['Newsreader', 'serif'], ['Spectral', 'serif'],
  ['Literata', 'serif'], ['Libre Caslon Text', 'serif'], ['Cardo', 'serif'], ['Old Standard TT', 'serif'], ['Instrument Serif', 'serif'], ['Young Serif', 'serif'],
  ['Bebas Neue', 'display'], ['Oswald', 'display'], ['Anton', 'display'], ['Abril Fatface', 'display'], ['Alfa Slab One', 'display'], ['Righteous', 'display'],
  ['Lobster', 'display'], ['Bungee', 'display'], ['Archivo Black', 'display'], ['Fredoka', 'display'], ['Comfortaa', 'display'], ['Baloo 2', 'display'],
  ['Passion One', 'display'], ['Russo One', 'display'], ['Bowlby One', 'display'], ['Staatliches', 'display'], ['Monoton', 'display'], ['Press Start 2P', 'display'],
  ['Orbitron', 'display'], ['Audiowide', 'display'], ['Bangers', 'display'], ['Chewy', 'display'], ['Luckiest Guy', 'display'], ['Titan One', 'display'],
  ['Dancing Script', 'handwriting'], ['Pacifico', 'handwriting'], ['Caveat', 'handwriting'], ['Shadows Into Light', 'handwriting'], ['Indie Flower', 'handwriting'], ['Satisfy', 'handwriting'],
  ['Great Vibes', 'handwriting'], ['Kalam', 'handwriting'], ['Patrick Hand', 'handwriting'], ['Amatic SC', 'handwriting'], ['Sacramento', 'handwriting'], ['Permanent Marker', 'handwriting'],
  ['Gloria Hallelujah', 'handwriting'], ['Courgette', 'handwriting'], ['Kaushan Script', 'handwriting'], ['Architects Daughter', 'handwriting'], ['Nanum Pen Script', 'handwriting'], ['Homemade Apple', 'handwriting'],
  ['JetBrains Mono', 'mono'], ['Fira Code', 'mono'], ['Source Code Pro', 'mono'], ['IBM Plex Mono', 'mono'], ['Roboto Mono', 'mono'], ['Space Mono', 'mono'],
  ['Inconsolata', 'mono'], ['Ubuntu Mono', 'mono'], ['DM Mono', 'mono'], ['Courier Prime', 'mono'], ['Red Hat Mono', 'mono'], ['Overpass Mono', 'mono'],
];

const GOOGLE_CATEGORY = new Map(GOOGLE_FONTS.map(([family, category]) => [family, category]));

// Font family names: letters, digits, spaces and a few separators, so they are safe in CSS and URLs.
export const FONT_FAMILY_PATTERN = /^[\p{L}\p{N} .'&+-]{1,60}$/u;
const CHOICE_PATTERN = /^(google|local):(.+)$/;

export const isCustomFontChoice = (value: string) => {
  const match = CHOICE_PATTERN.exec(value);
  return !!match && FONT_FAMILY_PATTERN.test(match[2]);
};

export const parseFontChoice = (value: string): { source: 'google' | 'local'; family: string } | null => {
  const match = CHOICE_PATTERN.exec(value);
  return match && FONT_FAMILY_PATTERN.test(match[2]) ? { source: match[1] as 'google' | 'local', family: match[2] } : null;
};

export const customFontStack = (source: 'google' | 'local', family: string) => {
  const category = (source === 'google' && GOOGLE_CATEGORY.get(family)) || 'sans';
  return `"${family.replace(/"/g, '')}", ${FALLBACK[category]}`;
};

const googleUrl = (family: string, text?: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap${text ? `&text=${encodeURIComponent(text)}` : ''}`;

const loaded = new Map<string, Promise<boolean>>();

/**
 * Load a Google font (once). `previewText` loads only those letters, for a light preview in the font
 * list. Resolves false when Google does not know the family.
 */
export function loadGoogleFont(family: string, previewText?: string): Promise<boolean> {
  const key = `${family}|${previewText || ''}`;
  const existing = loaded.get(key);
  if (existing) return existing;
  const promise = new Promise<boolean>(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = googleUrl(family, previewText);
    link.dataset.fileboxFont = family;
    link.onload = () => resolve(true);
    link.onerror = () => { link.remove(); loaded.delete(key); resolve(false); };
    document.head.appendChild(link);
  });
  loaded.set(key, promise);
  return promise;
}

/** Fonts installed on this computer (Chromium browsers, after the person allows it). */
export const canListLocalFonts = () => typeof (window as any).queryLocalFonts === 'function';

export async function listLocalFonts(): Promise<string[]> {
  const fonts: Array<{ family: string }> = await (window as any).queryLocalFonts();
  return Array.from(new Set(fonts.map(font => font.family)))
    .filter(family => FONT_FAMILY_PATTERN.test(family) && !family.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}
