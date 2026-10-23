export interface WorkspacePage {
  id: string;
  path: string;
  label: string;
  // Secondary pages are reachable from Settings instead of the sidebar.
  secondary?: boolean;
}

export const workspacePages: WorkspacePage[] = [
  { id: 'home', path: '/', label: 'Home' },
  { id: 'files', path: '/files', label: 'My Files' },
  { id: 'shared', path: '/shared', label: 'Shared' },
  { id: 'recent', path: '/recent', label: 'Recent' },
  { id: 'starred', path: '/starred', label: 'Starred' },
  { id: 'ai-assistant', path: '/ai', label: 'File Box AI' },
  { id: 'teams', path: '/team-spaces', label: 'Team Spaces' },
  { id: 'requests', path: '/file-requests', label: 'File Requests' },
  { id: 'signatures', path: '/signatures', label: 'Signatures' },
  { id: 'cloud-backup', path: '/folder-sync', label: 'Folder Sync' },
  { id: 'trash', path: '/trash', label: 'Trash' },
  { id: 'storage', path: '/storage', label: 'Storage' },
  { id: 'settings', path: '/settings', label: 'Settings' },
  { id: 'customize', path: '/customize', label: 'Customize' },
  { id: 'secured-links', path: '/secured-links', label: 'Secured links', secondary: true },
  { id: 'relationships', path: '/connections', label: 'File connections', secondary: true },
  { id: 'templates', path: '/templates', label: 'Templates', secondary: true },
  { id: 'shortcuts', path: '/web-shortcuts', label: 'Web shortcuts', secondary: true },
  { id: 'analytics', path: '/analytics', label: 'Storage analytics', secondary: true },
  { id: 'security', path: '/security', label: 'Security', secondary: true },
  { id: 'integrations', path: '/integrations', label: 'Integrations', secondary: true },
];

// Old URLs from before the restructure, so bookmarks keep working.
export const legacyPaths: Record<string, string> = {
  '/shared-files': '/shared',
  '/team-folders': '/team-spaces',
  '/cloud-backup': '/folder-sync',
  '/backup': '/folder-sync',
  '/ai-assistant': '/ai',
  '/relationships': '/connections',
};

// Student-product pages that are no longer part of File Box.
export const removedPaths = ['/student', '/learning', '/social'];

export const pagePath = (id: string) => workspacePages.find(page => page.id === id)?.path || '/';

export const getWorkspacePage = (pathname: string) =>
  workspacePages.find(page => pathname === page.path || (page.path !== '/' && pathname.startsWith(`${page.path}/`))) || workspacePages[0];
