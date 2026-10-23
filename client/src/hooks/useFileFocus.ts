import { useEffect } from 'react';
import { activityAPI } from '../services/api';

const BEAT_SECONDS = 30;

/**
 * While a file is open in File Box and the page is visible, report the time spent on it every
 * 30 seconds (and the remainder when it closes), so Home can show what the day was spent on.
 * Only time inside File Box is counted.
 */
export function useFileFocus(fileId?: string) {
  useEffect(() => {
    if (!fileId) return undefined;
    let last = Date.now();
    const report = (force = false) => {
      const seconds = Math.round((Date.now() - last) / 1000);
      last = Date.now();
      if (document.visibilityState !== 'visible' && !force) return;
      if (seconds >= (force ? 5 : BEAT_SECONDS - 2)) activityAPI.focus(fileId, Math.min(seconds, 60)).catch(() => {});
    };
    const timer = setInterval(() => report(), BEAT_SECONDS * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') report(true);
      else last = Date.now();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      report(true);
    };
  }, [fileId]);
}
