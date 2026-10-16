export const formatBytes = (bytes = 0) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
};

export const formatRelativeTime = (value?: string | Date) => {
  if (!value) return '';
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

// Coarse buckets for grouping lists by time.
export const timeBucket = (value?: string | Date) => {
  if (!value) return 'Older';
  const date = new Date(value);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (date >= startOfToday) return 'Today';
  if (date.getTime() >= startOfToday.getTime() - dayMs) return 'Yesterday';
  if (date.getTime() >= startOfToday.getTime() - 6 * dayMs) return 'Earlier this week';
  return 'Older';
};

export const fileKind = (mimeType = '', name = '') => {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.includes('pdf')) return 'PDF';
  if (mimeType.includes('word') || ['doc', 'docx', 'odt', 'rtf'].includes(extension)) return 'Document';
  if (mimeType.includes('sheet') || mimeType.includes('excel') || ['xls', 'xlsx', 'csv'].includes(extension)) return 'Spreadsheet';
  if (mimeType.includes('presentation') || ['ppt', 'pptx', 'key'].includes(extension)) return 'Presentation';
  if (mimeType.includes('zip') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return 'Archive';
  if (mimeType.startsWith('text/') || ['md', 'txt', 'json', 'js', 'ts', 'tsx', 'py', 'java', 'css', 'html'].includes(extension)) return 'Text';
  return 'File';
};

const INTERACTION_LABELS: Record<string, string> = {
  uploaded: 'You uploaded',
  edited: 'You edited',
  viewed: 'You opened',
  downloaded: 'You downloaded',
  renamed: 'You renamed',
  moved: 'You moved',
  copied: 'You copied',
  restored: 'You restored',
  starred: 'You starred',
  unstarred: 'You unstarred',
  shared: 'You shared',
  shared_with_you: 'Shared with you',
  commented: 'You commented',
  version_created: 'New version',
  version_restored: 'Version restored',
};

export const interactionLabel = (action?: string) => (action && INTERACTION_LABELS[action]) || 'Updated';
