/**
 * Board links: the address check the server also applies (services/boardBlocks.js), plus what a link block
 * shows instead of fetching anything: the domain and a lettered tile. Nothing here makes a network request.
 *
 * A domain name typed without a scheme gets https:// (example.com → https://example.com/). Local and IP
 * addresses must say http:// or https:// themselves, since there is no telling which a local service uses.
 */

export type LinkCheck = { ok: true; url: string } | { ok: false; error: string };

const WEB = 'Use a web address starting with https:// or http://.';
const LOCAL = 'For local or IP addresses, include http:// or https://.';
const MAX = 2000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Spaces and control characters (they can hide tricks such as "java script:"); matching them is the point.
// eslint-disable-next-line no-control-regex
const HIDDEN = new RegExp('[\\s\\u0000-\\u001f\\u007f]');

/** localhost, an IP address (v4 or [v6]), or a one-word network name: hosts that need an explicit scheme. */
const isLocalHost = (host: string) => {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || IPV4.test(h) || h.startsWith('[') || /^\d+$/.test(h) || !h.includes('.');
};

export function checkLink(input: string): LinkCheck {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Add a web address.' };
  if (HIDDEN.test(text)) return { ok: false, error: 'Web addresses cannot contain spaces or hidden characters.' };
  let candidate = text;
  // No scheme: "example.com/…", "localhost:3000", "[::1]:3000", "192.168.1.1/admin".
  const schemeLess = !/^[a-z][a-z0-9+.-]*:/i.test(text) || /^[^/:?#@[\]]+:\d+(?:[/?#]|$)/.test(text);
  if (schemeLess) {
    if (text.startsWith('//')) return { ok: false, error: WEB };
    const host = text.startsWith('[') ? text.slice(0, text.indexOf(']') + 1) : text.split(/[/:?#]/)[0];
    if (!host || /@/.test(text.split(/[/?#]/)[0])) return { ok: false, error: host ? "Links can't include a user name or password." : WEB };
    if (isLocalHost(host)) return { ok: false, error: LOCAL };
    candidate = `https://${text}`;
  }
  let url: URL;
  try { url = new URL(candidate); } catch { return { ok: false, error: "That web address isn't valid." }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: WEB };
  if (!url.hostname) return { ok: false, error: "That web address isn't valid." };
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:[\\/]*[^\\/?#]*@/i.test(candidate)) return { ok: false, error: "Links can't include a user name or password." };
  if (Array.from(url.href).length > MAX) return { ok: false, error: `Web addresses can be up to ${MAX.toLocaleString('en-US')} characters.` };
  return { ok: true, url: url.href };
}

/** What a link shows as its place: the host without a leading "www.", with its port if it has one. */
export function domainOf(href: string) {
  try {
    const url = new URL(href);
    return `${url.hostname.replace(/^www\./, '')}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return '';
  }
}

// Six tile colours, each at least 4.5:1 with a white letter.
const TILE_COLORS = ['#3f6b3a', '#235f94', '#9c3354', '#855a06', '#47566a', '#6b4aa0'];

/** The lettered tile for a link: the first letter of its domain, coloured by the domain (always the same). */
export function tileFor(href: string) {
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* shown as a globe */ }
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = TILE_COLORS[hash % TILE_COLORS.length];
  // IP addresses, local names and international (xn--) domains show a globe rather than a misleading letter.
  if (!host || isLocalHost(host) || host.split('.').some(part => part.startsWith('xn--'))) return { letter: '🌐', color, globe: true };
  const letter = (host.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
  return { letter, color, globe: false };
}
