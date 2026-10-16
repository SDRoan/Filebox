export const workspacePages = [
  { id: 'files', path: '/', label: 'Files' },
  { id: 'shared', path: '/shared-files', label: 'Shared with me' },
  { id: 'starred', path: '/starred', label: 'Starred' },
  { id: 'trash', path: '/trash', label: 'Trash' },
  { id: 'teams', path: '/team-folders', label: 'Team folders' },
  { id: 'student', path: '/student', label: 'Study space' },
  { id: 'learning', path: '/learning', label: 'Learning library' },
  { id: 'requests', path: '/file-requests', label: 'File requests' },
  { id: 'relationships', path: '/relationships', label: 'Connections' },
  { id: 'templates', path: '/templates', label: 'Templates' },
  { id: 'shortcuts', path: '/web-shortcuts', label: 'Web shortcuts' },
  { id: 'secured-links', path: '/secured-links', label: 'Secured links' },
  { id: 'cloud-backup', path: '/cloud-backup', label: 'Cloud backup' },
  { id: 'analytics', path: '/analytics', label: 'Analytics' },
  { id: 'security', path: '/security', label: 'Security' },
  { id: 'integrations', path: '/integrations', label: 'Integrations' },
  { id: 'ai-assistant', path: '/ai-assistant', label: 'Assistant' },
];

export const getWorkspacePage = (pathname: string) =>
  workspacePages.find(page => pathname === page.path || (page.path !== '/' && pathname.startsWith(`${page.path}/`))) || workspacePages[0];
