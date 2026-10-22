// Settings > Customize: the look a person chose for File Box. Mirrors client/src/theme/appearance.ts;
// unknown keys are dropped and every value is checked, so only well-formed choices are stored.

const FONTS = ['system', 'humanist', 'rounded', 'georgia', 'book', 'mono', 'condensed'];
// Or any Google / installed font: 'google:<Family>' / 'local:<Family>' (client/src/theme/fonts.ts).
const CUSTOM_FONT = /^(google|local):[\p{L}\p{N} .'&+-]{1,60}$/u;
const MAX_CUSTOM_CSS = 20000;
const HEX = /^#[0-9a-fA-F]{6}$/;
const BACKGROUND_KINDS = ['none', 'preset', 'image', 'url'];
const IMAGE_URL = /^https?:\/\/[^\s"'()\\<>]{1,2000}$/;
const BACKGROUND_IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_BACKGROUND_IMAGE = 3.5 * 1024 * 1024;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max).trim() : '');
const color = (value) => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const num = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback);
const font = (value, fallback) => (FONTS.includes(value) || (typeof value === 'string' && CUSTOM_FONT.test(value)) ? value : fallback);
const ids = (value) => (Array.isArray(value) ? value.filter(v => typeof v === 'string').map(v => v.slice(0, 40)).slice(0, 50) : []);
const labels = (value) => {
  const out = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.entries(value).slice(0, 50).forEach(([key, v]) => {
      const t = text(v, 40);
      if (t && /^[a-z0-9-]{1,40}$/.test(key)) out[key] = t;
    });
  }
  return out;
};

function sanitizeAppearance(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const s = input.sidebar && typeof input.sidebar === 'object' ? input.sidebar : {};
  const h = input.home && typeof input.home === 'object' ? input.home : {};
  const bg = input.background && typeof input.background === 'object' ? input.background : {};
  return {
    mode: input.mode === 'dark' ? 'dark' : 'light',
    bodyFont: font(input.bodyFont, 'system'),
    headingFont: font(input.headingFont, 'georgia'),
    textScale: num(input.textScale, 1, 0.85, 1.3),
    roundness: num(input.roundness, 1, 0, 2.5),
    pageColor: color(input.pageColor),
    surfaceColor: color(input.surfaceColor),
    sidebarColor: color(input.sidebarColor),
    headerColor: color(input.headerColor),
    brandName: text(input.brandName, 30),
    reduceMotion: bool(input.reduceMotion, false),
    sidebar: {
      position: s.position === 'right' ? 'right' : 'left',
      style: s.style === 'icons' ? 'icons' : 'full',
      showSectionTitles: bool(s.showSectionTitles, true),
      hidden: ids(s.hidden),
      order: ids(s.order),
      labels: labels(s.labels),
      sectionTitles: labels(s.sectionTitles),
    },
    home: {
      title: text(h.title, 60),
      showGreeting: bool(h.showGreeting, true),
      showShortcuts: bool(h.showShortcuts, true),
      showDay: bool(h.showDay, true),
      showSuggestions: bool(h.showSuggestions, true),
    },
    background: {
      kind: BACKGROUND_KINDS.includes(bg.kind) ? bg.kind : 'none',
      preset: typeof bg.preset === 'string' && /^[a-z0-9-]{1,30}$/.test(bg.preset) ? bg.preset : '',
      url: typeof bg.url === 'string' && IMAGE_URL.test(bg.url) ? bg.url : '',
      fade: num(bg.fade, 0.55, 0, 0.95),
      blur: num(bg.blur, 0, 0, 24),
      behindSidebar: bool(bg.behindSidebar, false),
    },
    customCss: typeof input.customCss === 'string' ? input.customCss.slice(0, MAX_CUSTOM_CSS) : '',
  };
}

const isBackgroundImage = (value) => typeof value === 'string' && value.length <= MAX_BACKGROUND_IMAGE && BACKGROUND_IMAGE.test(value);

module.exports = { sanitizeAppearance, isBackgroundImage, MAX_CUSTOM_CSS };
