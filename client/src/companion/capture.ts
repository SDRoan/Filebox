import { domToJpeg } from 'modern-screenshot';

/**
 * Ask File Box's on-demand screenshot of what is visible in File Box right now: the app's own page at
 * the size of the window (browser tabs, the address bar and other apps are not part of the page and
 * cannot be captured). The companion panel, its button and the phone backdrop are left out. The image
 * stays in memory: it is sent with one question to the local File Box server and then dropped.
 * Only called when a question needs the screen (never on navigation, scrolling or a timer).
 */

// The companion itself, and page parts that are never visible (the no-JavaScript fallback, scripts, styles).
const EXCLUDED = '.companion-panel, .companion-launcher, .companion-sheet-backdrop, noscript, script, style, template';
// Wide enough to read File Box's labels, small enough for the local vision model to answer quickly.
const MAX_WIDTH = 1024;

// Counted for tests and diagnostics only (no image data is kept).
let captures = 0;
export const captureCount = () => captures;

export interface ScreenCapture { image: string; width: number; height: number }

export async function captureFileBox(): Promise<ScreenCapture> {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = Math.min(1, MAX_WIDTH / width);
  const dark = document.documentElement.classList.contains('fb-dark');
  captures += 1;
  // Development builds expose the count (not the images) so tests can check that nothing was captured.
  if (process.env.NODE_ENV === 'development') (window as any).__fileboxScreenCaptures = captures;
  const dataUrl = await domToJpeg(document.body, {
    width,
    height,
    scale,
    quality: 0.8,
    backgroundColor: '#ffffff',
    timeout: 8000,
    filter: (node) => !(node instanceof Element && node.matches(EXCLUDED)),
    // Dark mode turns the whole page around on <html>; the copy is turned the same way.
    style: dark ? { filter: 'invert(1) hue-rotate(180deg)' } : undefined,
  });
  return { image: dataUrl.replace(/^data:image\/jpeg;base64,/, ''), width: Math.round(width * scale), height: Math.round(height * scale) };
}
