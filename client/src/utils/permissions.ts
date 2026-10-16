// Mirrors server/services/permissions.js capabilitiesFor(). The server always re-checks;
// this only decides which actions the UI offers.
export type AccessRole = 'owner' | 'editor' | 'viewer';

export interface Capabilities {
  role: AccessRole;
  canView: boolean;
  canDownload: boolean;
  canComment: boolean;
  canEdit: boolean;
  canShare: boolean;
  canRename: boolean;
  canMove: boolean;
  canCopy: boolean;
  canTrash: boolean;
  canStar: boolean;
  canViewVersions: boolean;
}

export const capabilitiesFor = (role: AccessRole = 'owner'): Capabilities => {
  const owner = role === 'owner';
  const editor = owner || role === 'editor';
  return {
    role,
    canView: true,
    canDownload: true,
    canComment: true,
    canEdit: editor,
    canShare: owner,
    canRename: owner,
    canMove: owner,
    canCopy: owner,
    canTrash: owner,
    canStar: owner,
    canViewVersions: editor,
  };
};

export const roleLabel = (role?: string) => {
  if (role === 'owner') return 'Owner';
  if (role === 'editor' || role === 'edit') return 'Can edit';
  return 'Can view';
};
