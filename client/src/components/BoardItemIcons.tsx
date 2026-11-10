import React from 'react';
import type { BoardBlock } from '../services/api';

/** One icon per kind of Board item, shared by the Add menu and the Connections graph. */
const icon = (paths: React.ReactNode) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
export const ITEM_ICONS: Record<BoardBlock['type'], React.ReactNode> = {
  sticker: icon(<><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9.2 9.5h.01M14.8 9.5h.01" /></>),
  shape: icon(<><rect x="3.5" y="3.5" width="10" height="10" rx="1.5" /><circle cx="15.5" cy="15.5" r="5" /></>),
  file: icon(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>),
  folder: icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  filelist: icon(<><path d="M9 6h11M9 12h11M9 18h11" /><rect x="3.5" y="4.5" width="3" height="3" rx="0.6" /><rect x="3.5" y="10.5" width="3" height="3" rx="0.6" /><rect x="3.5" y="16.5" width="3" height="3" rx="0.6" /></>),
  search: icon(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /><path d="M8.5 11h5" /></>),
  note: icon(<><path d="M5 4h14v11l-5 5H5z" /><path d="M14 20v-5h5" /></>),
  text: icon(<><path d="M5 6h14M5 11h14M5 16h9" /></>),
  deadline: icon(<><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17" /><path d="M12 13v3l2 1" /></>),
  label: icon(<><path d="M4 12V5a1 1 0 0 1 1-1h7l8 8-8 8-8-8z" /><circle cx="8.5" cy="8.5" r="1.3" /></>),
  link: icon(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
};
