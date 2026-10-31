import type { ImageCaption } from '../types';
import axios from 'axios';
import { LOCAL_PREVIEW_ENABLED } from '../config/localPreview';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Share session creation across concurrent requests, including startup recovery.
let localSessionRequest: Promise<any> | null = null;
const getLocalSession = () => {
  if (!localSessionRequest) {
    localSessionRequest = axios.post(`${API_URL}/auth/local-session`, {}, {
      headers: { 'X-Filebox-Local': 'true' }, timeout: 10000,
    }).then(response => {
      sessionStorage.setItem('filebox-local-token', response.data.token);
      return response.data;
    }).finally(() => { localSessionRequest = null; });
  }
  return localSessionRequest;
};

const currentToken = async (url = '') => {
  let token = LOCAL_PREVIEW_ENABLED ? sessionStorage.getItem('filebox-local-token') : localStorage.getItem('token');
  if (LOCAL_PREVIEW_ENABLED && !token && !url.startsWith('/auth/')) {
    token = (await getLocalSession()).token;
  }
  return token;
};

// Ensure a real session exists before sending any workspace request.
api.interceptors.request.use(async (config) => {
  const token = await currentToken(config.url);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Don't override Content-Type for FormData (file uploads) - let browser set it with boundary
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  return config;
});

// A local session may expire or become invalid after a backend restart.
api.interceptors.response.use(response => response, async error => {
  const config = error.config;
  if (!LOCAL_PREVIEW_ENABLED || error.response?.status !== 401 || !config ||
      config.url?.startsWith('/auth/') || config.localSessionRetried) {
    return Promise.reject(error);
  }
  config.localSessionRetried = true;
  let token = sessionStorage.getItem('filebox-local-token');
  if (!token || config.headers.Authorization === `Bearer ${token}`) {
    token = (await getLocalSession()).token;
  }
  config.headers.Authorization = `Bearer ${token}`;
  return api.request(config);
});

// Auth API
export const authAPI = {
  localSession: getLocalSession,
  register: async (email: string, password: string, name: string) => {
    const response = await api.post('/auth/register', { email, password, name });
    return response.data;
  },
  verifyCode: async (email: string, code: string) => {
    const response = await api.post('/auth/verify-code', { email, code });
    return response.data;
  },
  resendCode: async (email: string) => {
    const response = await api.post('/auth/resend-code', { email });
    return response.data;
  },
  login: async (email: string, password: string) => {
    const response = await api.post('/auth/login', { email, password });
    return response.data;
  },
  forgotPassword: async (email: string) => {
    const response = await api.post('/auth/forgot-password', { email });
    return response.data;
  },
  resetPassword: async (email: string, code: string, password: string) => {
    const response = await api.post('/auth/reset-password', { email, code, password });
    return response.data;
  },
  getCurrentUser: async () => {
    const response = await api.get('/auth/me');
    return response.data;
  },
};

// Security API
export const securityAPI = {
  getDashboard: async () => {
    const response = await api.get('/security/dashboard');
    return response.data;
  },
  getAuditLogs: async (params?: { page?: number; limit?: number; action?: string; startDate?: string; endDate?: string }) => {
    const response = await api.get('/security/audit-logs', { params });
    return response.data;
  },
  updateSettings: async (settings: { sessionTimeout?: number; requireIpWhitelist?: boolean; ipWhitelist?: string[] }) => {
    const response = await api.put('/security/settings', settings);
    return response.data;
  },
  updateClassification: async (type: 'file' | 'folder', id: string, dataClassification: string) => {
    const response = await api.put(`/security/classification/${type}/${id}`, { dataClassification });
    return response.data;
  },
  toggleWatermark: async (fileId: string, enabled: boolean) => {
    const response = await api.put(`/security/watermark/${fileId}`, { enabled });
    return response.data;
  },
};

// Files API
export const filesAPI = {
  getFiles: async (folderId?: string, trashed?: boolean, starred?: boolean) => {
    const params: any = {};
    if (folderId) params.folderId = folderId;
    if (trashed) params.trashed = 'true';
    if (starred) params.starred = 'true';
    const response = await api.get('/files', { params });
    return response.data;
  },
  getStorageSummary: async () => {
    const response = await api.get('/files/storage/summary');
    return response.data;
  },
  recalculateStorage: async () => {
    const response = await api.post('/files/storage/recalculate');
    return response.data;
  },
  getTrashSummary: async () => {
    const response = await api.get('/files/trash/summary');
    return response.data;
  },
  emptyTrash: async () => {
    const response = await api.delete('/files/trash', { data: { confirm: true } });
    return response.data;
  },
  getRecent: async (limit = 30) => {
    const response = await api.get('/files/recent', { params: { limit } });
    return response.data;
  },
  getFileById: async (fileId: string) => {
    const response = await api.get(`/files/file/${fileId}`);
    return response.data;
  },
  getFolder: async (folderId: string) => {
    const response = await api.get(`/files/folder/${folderId}`);
    return response.data.folder;
  },
  uploadFile: async (file: File, parentFolder?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (parentFolder) formData.append('parentFolder', parentFolder);
    const response = await api.post('/files/upload', formData, {
      timeout: 60000, // 60 second timeout for large files
    });
    return response.data;
  },
  createFolder: async (name: string, parentFolder?: string) => {
    const response = await api.post('/files/folder', { name, parentFolder });
    return response.data;
  },
  // { view: true } when a file is only being opened to look at it (preview, editor), not saved to disk.
  downloadFile: async (fileId: string, options: { view?: boolean } = {}) => {
    const response = await api.get(`/files/download/${fileId}${options.view ? '?purpose=view' : ''}`, {
      responseType: 'blob',
    });
    return response.data;
  },
  // An image for a file card; not recorded as a view or download.
  getThumbnail: async (fileId: string) => {
    const response = await api.get(`/files/download/${fileId}?purpose=thumbnail`, { responseType: 'blob' });
    return response.data as Blob;
  },
  getCaption: async (fileId: string) => {
    const response = await api.get(`/files/${fileId}/caption`);
    return response.data as { canCaption: boolean; caption: ImageCaption | null };
  },
  newCaption: async (fileId: string) => {
    const response = await api.post(`/files/${fileId}/caption`);
    return response.data as { caption: ImageCaption };
  },
  deleteFile: async (fileId: string) => {
    const response = await api.delete(`/files/${fileId}?type=file`);
    return response.data;
  },
  deleteFolder: async (folderId: string) => {
    const response = await api.delete(`/files/${folderId}?type=folder`);
    return response.data;
  },
  permanentDeleteFile: async (fileId: string) => {
    const response = await api.delete(`/files/permanent/${fileId}?type=file`);
    return response.data;
  },
  permanentDeleteFolder: async (folderId: string) => {
    const response = await api.delete(`/files/permanent/${folderId}?type=folder`);
    return response.data;
  },
  restoreFile: async (fileId: string) => {
    const response = await api.post(`/files/restore/${fileId}?type=file`);
    return response.data;
  },
  restoreFolder: async (folderId: string) => {
    const response = await api.post(`/files/restore/${folderId}?type=folder`);
    return response.data;
  },
  starFile: async (fileId: string) => {
    const response = await api.post(`/files/star/${fileId}?type=file`);
    return response.data;
  },
  starFolder: async (folderId: string) => {
    const response = await api.post(`/files/star/${folderId}?type=folder`);
    return response.data;
  },
  renameFile: async (fileId: string, name: string) => {
    const response = await api.patch(`/files/rename/${fileId}`, { name, type: 'file' });
    return response.data;
  },
  renameFolder: async (folderId: string, name: string) => {
    const response = await api.patch(`/files/rename/${folderId}`, { name, type: 'folder' });
    return response.data;
  },
  moveFile: async (fileId: string, targetFolderId?: string) => {
    const response = await api.patch(`/files/move/${fileId}`, { type: 'file', targetFolderId: targetFolderId || 'root' });
    return response.data;
  },
  moveFolder: async (folderId: string, targetFolderId?: string) => {
    const response = await api.patch(`/files/move/${folderId}`, { type: 'folder', targetFolderId: targetFolderId || 'root' });
    return response.data;
  },
  copyFile: async (fileId: string, targetFolderId?: string) => {
    const response = await api.post(`/files/copy/${fileId}`, { targetFolderId: targetFolderId || 'root' });
    return response.data;
  },
  downloadFolderAsZip: async (folderId: string) => {
    const response = await api.get(`/files/download-folder/${folderId}`, {
      responseType: 'blob',
    });
    return response.data;
  },
  getFileVersions: async (fileId: string) => {
    const response = await api.get(`/files/versions/${fileId}`);
    return response.data;
  },
  downloadFileVersion: async (versionId: string) => {
    const response = await api.get(`/files/version/${versionId}/download`, {
      responseType: 'blob',
    });
    return response.data;
  },
  restoreFileVersion: async (versionId: string) => {
    const response = await api.post(`/files/version/${versionId}/restore`);
    return response.data;
  },
  uploadFileVersion: async (fileId: string, file: File, changeDescription?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (changeDescription) formData.append('changeDescription', changeDescription);
    const response = await api.put(`/files/update/${fileId}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  getFileActivity: async (fileId: string) => {
    const response = await api.get(`/files/activity/${fileId}`);
    return response.data;
  },
  getFolderActivity: async (folderId: string) => {
    const response = await api.get(`/files/folder-activity/${folderId}`);
    return response.data;
  },
  getUserActivity: async () => {
    const response = await api.get('/files/activity');
    return response.data;
  },
  getPreviewText: async (fileId: string) => {
    const response = await api.get(`/files/preview-text/${fileId}`);
    return response.data;
  },
  updateFile: async (fileId: string, blob: Blob, fileName: string) => {
    const formData = new FormData();
    formData.append('file', blob, fileName);
    const response = await api.put(`/files/update/${fileId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },
  updateFileAsDocx: async (fileId: string, text: string, fileName: string) => {
    const response = await api.put(`/files/update-docx/${fileId}`, { text, fileName });
    return response.data;
  },
  updateFileAsPdf: async (fileId: string, text: string, fileName: string) => {
    const response = await api.put(`/files/update-pdf/${fileId}`, { text, fileName });
    return response.data;
  },
};

// Team Folders API
export const teamFoldersAPI = {
  getTeamFolders: async () => {
    const response = await api.get('/team-folders');
    return response.data;
  },
  createTeamFolder: async (name: string, parentFolder?: string) => {
    const response = await api.post('/team-folders', { name, parentFolder });
    return response.data;
  },
  getTeamFolder: async (folderId: string) => {
    const response = await api.get(`/team-folders/${folderId}`);
    return response.data;
  },
  addMember: async (folderId: string, email: string, role: 'admin' | 'editor' | 'viewer') => {
    const response = await api.post(`/team-folders/${folderId}/members`, { email, role });
    return response.data;
  },
  setMemberRole: async (folderId: string, userId: string, role: 'admin' | 'editor' | 'viewer') => {
    const response = await api.post(`/team-folders/${folderId}/members`, { userId, role });
    return response.data;
  },
  renameTeamFolder: async (folderId: string, name: string) => {
    const response = await api.patch(`/team-folders/${folderId}`, { name });
    return response.data;
  },
  removeMember: async (folderId: string, userId: string) => {
    const response = await api.delete(`/team-folders/${folderId}/members/${userId}`);
    return response.data;
  },
  getTeamFolderFiles: async (folderId: string) => {
    const response = await api.get(`/team-folders/${folderId}/files`);
    return response.data;
  },
  uploadFile: async (folderId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post(`/team-folders/${folderId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },
  createFolder: async (folderId: string, folderName: string) => {
    const response = await api.post(`/team-folders/${folderId}/folders`, { name: folderName });
    return response.data;
  },
  deleteTeamFolder: async (folderId: string) => {
    const response = await api.delete(`/team-folders/${folderId}`);
    return response.data;
  },
  // Messaging (Slack-like features)
  getMessages: async (folderId: string, params?: { limit?: number; before?: string }) => {
    const response = await api.get(`/team-folders/${folderId}/messages`, { params });
    return response.data;
  },
  sendMessage: async (folderId: string, message: string, threadParent?: string, fileId?: string) => {
    const response = await api.post(`/team-folders/${folderId}/messages`, {
      message,
      threadParent,
      fileId
    });
    return response.data;
  },
  getThreadReplies: async (folderId: string, messageId: string) => {
    const response = await api.get(`/team-folders/${folderId}/messages/${messageId}/thread`);
    return response.data;
  },
  editMessage: async (folderId: string, messageId: string, message: string) => {
    const response = await api.patch(`/team-folders/${folderId}/messages/${messageId}`, { message });
    return response.data;
  },
  deleteMessage: async (folderId: string, messageId: string) => {
    const response = await api.delete(`/team-folders/${folderId}/messages/${messageId}`);
    return response.data;
  },
  addReaction: async (folderId: string, messageId: string, emoji: string) => {
    const response = await api.post(`/team-folders/${folderId}/messages/${messageId}/reactions`, { emoji });
    return response.data;
  },
  removeReaction: async (folderId: string, messageId: string, emoji: string) => {
    const response = await api.delete(`/team-folders/${folderId}/messages/${messageId}/reactions/${emoji}`);
    return response.data;
  },
  pinMessage: async (folderId: string, messageId: string) => {
    const response = await api.post(`/team-folders/${folderId}/messages/${messageId}/pin`);
    return response.data;
  },
};

// File Requests API
export const fileRequestsAPI = {
  getFileRequests: async () => {
    const response = await api.get('/file-requests');
    return response.data;
  },
  createFileRequest: async (title: string, description?: string, folderId?: string, expiresAt?: string) => {
    const response = await api.post('/file-requests', { title, description, folderId, expiresAt });
    return response.data;
  },
  getFileRequest: async (requestId: string) => {
    const response = await api.get(`/file-requests/${requestId}`);
    return response.data;
  },
  uploadToRequest: async (requestId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post(`/file-requests/${requestId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },
  closeFileRequest: async (requestId: string) => {
    const response = await api.patch(`/file-requests/${requestId}/close`);
    return response.data;
  },
  deleteFileRequest: async (requestId: string) => {
    const response = await api.delete(`/file-requests/${requestId}`);
    return response.data;
  },
};

// Comments API
export const commentsAPI = {
  getFileComments: async (fileId: string) => {
    const response = await api.get(`/comments/file/${fileId}`);
    return response.data;
  },
  addComment: async (fileId: string, text: string) => {
    const response = await api.post(`/comments/file/${fileId}`, { text });
    return response.data;
  },
  updateComment: async (commentId: string, text: string) => {
    const response = await api.patch(`/comments/${commentId}`, { text });
    return response.data;
  },
  deleteComment: async (commentId: string) => {
    const response = await api.delete(`/comments/${commentId}`);
    return response.data;
  },
  addReply: async (commentId: string, text: string) => {
    const response = await api.post(`/comments/${commentId}/reply`, { text });
    return response.data;
  },
};

// Share API
export interface ShareLinkInfo {
  shareId: string;
  url: string;
  hasPassword: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  expired: boolean;
  downloadCount: number;
  createdAt: string;
}

export interface FileAccessInfo {
  file: { _id: string; originalName: string; mimeType: string };
  owner: { _id: string; name: string; email: string };
  people: Array<{
    user: { _id: string; name: string; email: string };
    permission: 'view' | 'edit';
    expiresAt: string | null;
    expired: boolean;
    sharedAt: string | null;
  }>;
  links: ShareLinkInfo[];
}

export const shareAPI = {
  getFileAccess: async (fileId: string): Promise<FileAccessInfo> => {
    const response = await api.get(`/share/file/${fileId}`);
    return response.data;
  },
  shareWithEmail: async (fileId: string, email: string, permission: 'view' | 'edit', expiresAt?: string | null) => {
    const response = await api.post('/share/user', { fileId, email, permission, expiresAt: expiresAt ?? undefined });
    return response.data;
  },
  setPermission: async (fileId: string, userId: string, permission: 'view' | 'edit') => {
    const response = await api.post('/share/user', { fileId, userId, permission });
    return response.data;
  },
  removeAccess: async (fileId: string, userId: string) => {
    const response = await api.delete(`/share/user/${fileId}/${userId}`);
    return response.data;
  },
  createLink: async (fileId: string, options: { password?: string; expiresAt?: string; allowDownload?: boolean } = {}): Promise<ShareLinkInfo> => {
    const response = await api.post('/share/create', { fileId, ...options });
    return response.data;
  },
  // Public (no sign-in) link endpoints
  getPublicLink: async (shareId: string) => {
    const response = await api.get(`/share/${shareId}`);
    return response.data;
  },
  publicDownloadUrl: (shareId: string, password?: string) =>
    `${API_URL}/share/${shareId}/download${password ? `?password=${encodeURIComponent(password)}` : ''}`,
  getSharedWithMe: async () => {
    const response = await api.get('/share/shared/with-me');
    return response.data;
  },
  getSharedByMe: async () => {
    const response = await api.get('/share/shared/by-me');
    return response.data;
  },
  getSharedFileActivity: async (fileId: string) => {
    const response = await api.get(`/share/activity/${fileId}`);
    return response.data;
  },
  getSharedFilesStats: async () => {
    const response = await api.get('/share/shared/by-me/stats');
    return response.data;
  },
  removeShare: async (shareId: string) => {
    const response = await api.delete(`/share/${shareId}`);
    return response.data;
  },
};

// Users API
export const usersAPI = {
  getProfile: async () => {
    const response = await api.get('/users/profile');
    return response.data;
  },
  updateProfile: async (name?: string, email?: string) => {
    const response = await api.patch('/users/profile', { name, email });
    return response.data;
  },
  // Exact email lookup only; File Box does not expose a user directory.
  searchUsers: async (query: string) => {
    const response = await api.get('/users/search', { params: { q: query } });
    return response.data;
  },
  // Kept for the hidden student components; the user list endpoint was removed for privacy.
  getAllUsers: async (): Promise<any[]> => [],
};

// Search API
export const searchAPI = {
  aiSearch: async (query: string) => {
    const response = await api.get('/search/ai', { params: { q: query } });
    return response.data;
  },
  extractText: async (fileId: string) => {
    const response = await api.post(`/search/extract/${fileId}`);
    return response.data;
  },
  extractAll: async (force: boolean = true) => {
    const response = await api.post('/search/extract-all', { force });
    return response.data;
  },
};

// Boards (/boards): a person's own tabbed workspace (server/services/workspaceBoards.js).
export interface BoardTab {
  id: string;
  name: string;
  icon: string;
  color: string;
  order: number;
  isDefault: boolean;
  // Revision the browser last saw; sent back with every change so another device's edit is never overwritten.
  rev: number;
  blocks: unknown[];
  blockCount: number;
  searchCount?: number;
  updatedAt?: string;
}

// A block's file or folder as the person can see it now. Anything they cannot open is only { available: false }.
export type BoardRef =
  | { available: false }
  | {
    available: true;
    fileId?: string;
    folderId?: string;
    name: string;
    mimeType?: string;
    size?: number;
    technicalType?: 'pdf' | 'image' | 'document' | 'text' | 'code' | 'other';
    updatedAt?: string;
    source: 'owned' | 'shared' | 'team';
    role?: 'owner' | 'editor' | 'viewer';
    isStarred?: boolean;
    parentFolder?: string | null;
    ownerName?: string | null;
    teamName?: string;
    category?: string;
    documentType?: string;
    itemCount?: number;
    // What the board's file and folder cards show (the same cards as in My Files).
    createdAt?: string;
    dataClassification?: 'Public' | 'Internal' | 'Confidential' | 'Top Secret';
    aiCaption?: { text?: string; hashtags?: string[]; status?: '' | 'writing' | 'done' | 'failed'; error?: string };
  };

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'orange';
export interface BoardNote { title: string; body: string; color: NoteColor }
// A text area's document: ProseMirror/TipTap JSON, cleaned by the server against an allowlist (never HTML).
export interface RichTextNode { type: string; attrs?: Record<string, unknown>; content?: RichTextNode[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }
export interface BoardText { doc: RichTextNode }
// Board-only blocks (server/services/boardBlocks.js).
export type LabelSize = 's' | 'm' | 'l';
export type LabelTone = 'default' | 'sage' | 'sky' | 'rose' | 'amber' | 'slate';
export interface BoardLabel { text: string; size: LabelSize; align: 'left' | 'center' | 'right'; tone: LabelTone }
// A date-only deadline is due at the end of that calendar day wherever it is viewed; a timed one also keeps
// the exact moment (UTC) its date and time meant where it was set.
export interface BoardDeadline { title: string; note: string; due: { date: string; time: string | null; at: string | null } | null; completedAt: string | null }
// A link: an http(s) address (as the URL parser writes it), an optional title and note. Never fetched.
export interface BoardLink { url: string; title: string; note: string }
// A file list: a title and rows in order, each with its own row id, pointing at files (resolved live, like file
// cards). A row whose file cannot be opened now is { id, ref: { available: false } } and keeps its place.
// `fileId` is only on a row added here since the last save (the server checks it); saved rows never carry one.
export interface BoardFileListRow { id: string; ref: BoardRef; fileId?: string }
export interface BoardFileList { title: string; items: BoardFileListRow[] }
// A saved search: only the structured filters Advanced Search runs with, and how many results to show.
// Results are never stored; they are worked out with current access each time (see runSearches).
export interface BoardSavedSearch {
  title: string; text: string; category: string; documentType: string; topic: string;
  format: 'all' | 'pdf' | 'image' | 'document' | 'text' | 'code' | 'other';
  date: 'any' | 'today' | 'week' | 'month' | 'year' | 'custom'; from: string | null; to: string | null;
  dateField: 'modified' | 'uploaded';
  location: 'everywhere' | 'my-files' | 'shared' | 'team' | 'folder'; folderId: string | null; teamId: string | null;
  sort: 'best' | 'content' | 'modified' | 'newest' | 'oldest' | 'name';
  show: 3 | 5 | 10;
}
// One result row of a saved search (what the block shows and the preview needs; no snippet).
export type SavedSearchRow = Pick<AdvancedSearchResult, '_id' | 'originalName' | 'mimeType' | 'size' | 'technicalType' | 'createdAt' | 'updatedAt' | 'parentFolder' | 'folderName' | 'isStarred' | 'ownerName' | 'access'>;
export type SavedSearchRun =
  | { id: string; state: 'ok'; total: number; results: SavedSearchRow[]; scopeName?: string; tookMs?: number }
  | { id: string; state: 'unavailable' | 'error' };
// The content of a block that is not a file or folder, in a field named after its type.
export interface BoardContent { note?: BoardNote; text?: BoardText; label?: BoardLabel; deadline?: BoardDeadline; link?: BoardLink; filelist?: BoardFileList; search?: BoardSavedSearch }

// A place on the free canvas in pixels; null x/y = not placed yet (the board puts it below everything).
// Sticky notes and text areas also have a width and height.
interface BoardPlace { id: string; x: number | null; y: number | null; w?: number; h?: number }
export type BoardBlock =
  | (BoardPlace & { type: 'file' | 'folder'; ref: BoardRef })
  | (BoardPlace & { type: 'note'; note: BoardNote })
  | (BoardPlace & { type: 'text'; text: BoardText })
  | (BoardPlace & { type: 'label'; label: BoardLabel })
  | (BoardPlace & { type: 'deadline'; deadline: BoardDeadline })
  | (BoardPlace & { type: 'link'; link: BoardLink })
  | (BoardPlace & { type: 'filelist'; filelist: BoardFileList })
  | (BoardPlace & { type: 'search'; search: BoardSavedSearch });

// What a save sends: positions for every block; a file/folder id only for blocks added since the last save;
// a note's or text area's words only when they changed (the server keeps the stored ones otherwise).
export interface BoardBlockInput {
  id: string; type: BoardBlock['type']; x: number | null; y: number | null; w?: number; h?: number;
  fileId?: string; folderId?: string; note?: BoardNote; text?: BoardText;
  label?: BoardLabel; deadline?: BoardDeadline; link?: BoardLink;
  // A file list's rows: { id } for a row the server has (it keeps that row's file), { id, fileId } for a new one.
  filelist?: { title: string; items: Array<{ id: string; fileId?: string }> };
  search?: BoardSavedSearch;
}

export interface BoardLimits { tabs: number; blocksPerTab: number; fileRefsPerTab: number; searchesPerTab: number; tabName: number; noteTitle: number; noteBody: number; richTextChars: number; richTextBytes: number; tabBytes: number; totalBytes: number }

export const workspaceBoardsAPI = {
  list: async (): Promise<{ tabs: BoardTab[]; limits: BoardLimits; colors: string[] }> => {
    const response = await api.get('/workspace-boards');
    return response.data;
  },
  createTab: async (body: { name: string; icon?: string; color?: string }): Promise<{ tab: BoardTab }> => {
    const response = await api.post('/workspace-boards/tabs', body);
    return response.data;
  },
  updateTab: async (tabId: string, body: { name?: string; icon?: string; color?: string; rev: number }): Promise<{ tab: BoardTab }> => {
    const response = await api.patch(`/workspace-boards/tabs/${tabId}`, body);
    return response.data;
  },
  deleteTab: async (tabId: string): Promise<{ tabs: BoardTab[]; deleted: string }> => {
    const response = await api.delete(`/workspace-boards/tabs/${tabId}`);
    return response.data;
  },
  /** Copy a tab (its notes, text and the items it points at that are available now; never the files themselves). */
  duplicateTab: async (tabId: string): Promise<{ tab: BoardTab; tabs: BoardTab[]; skipped: number }> => {
    const response = await api.post(`/workspace-boards/tabs/${tabId}/duplicate`);
    return response.data;
  },
  // Every tab id once, in the new order. A 409 carries the latest { tabs }.
  reorderTabs: async (tabIds: string[]): Promise<{ tabs: BoardTab[] }> => {
    const response = await api.put('/workspace-boards/tabs/order', { tabIds });
    return response.data;
  },
  setDefaultTab: async (tabId: string): Promise<{ tabs: BoardTab[] }> => {
    const response = await api.post(`/workspace-boards/tabs/${tabId}/default`);
    return response.data;
  },
  /** Which of my tabs already hold this file or folder. */
  placements: async (ref: { fileId?: string; folderId?: string }): Promise<{ tabIds: string[] }> => {
    const response = await api.get('/workspace-boards/placements', { params: ref });
    return response.data;
  },
  /** Add a file or folder to a tab (checked by the server); the board places it below everything. */
  addRef: async (tabId: string, type: 'file' | 'folder', id: string): Promise<{ tab: BoardTab; added: boolean }> => {
    const response = await api.post(`/workspace-boards/tabs/${tabId}/refs`, { type, id });
    return response.data;
  },
  /** Run saved searches (their stored filters) with current access; at most 10 blocks. Nothing is stored. */
  runSearches: async (tabId: string, blockIds: string[], signal?: AbortSignal): Promise<{ searches: SavedSearchRun[] }> => {
    const response = await api.post(`/workspace-boards/tabs/${tabId}/searches/run`, { blockIds, tz: new Date().getTimezoneOffset() }, { signal });
    return response.data;
  },
  /** "Save to board…" from Advanced Search: a saved-search block with these filters (placed below everything). */
  addSearch: async (tabId: string, search: BoardSavedSearch): Promise<{ tab: BoardTab; blockId: string }> => {
    const response = await api.post(`/workspace-boards/tabs/${tabId}/searches`, { search });
    return response.data;
  },
  getTab: async (tabId: string): Promise<{ tab: BoardTab; blocks: BoardBlock[]; zones: BoardZone[] }> => {
    const response = await api.get(`/workspace-boards/tabs/${tabId}`);
    return response.data;
  },
  // A 409 carries the latest { tab, blocks, zones } (changed on another device).
  saveBlocks: async (tabId: string, rev: number, blocks: BoardBlockInput[], zones: BoardZone[]): Promise<{ tab: BoardTab; blocks: BoardBlock[]; zones: BoardZone[] }> => {
    const response = await api.put(`/workspace-boards/tabs/${tabId}/blocks`, { rev, blocks, zones });
    return response.data;
  },
  /**
   * Best-effort save while the page is being hidden or closed (fetch keepalive, which browsers limit to about
   * 64 KB). Not guaranteed to finish; returns false when it could not even be sent.
   */
  saveBlocksOnLeave: (tabId: string, rev: number, blocks: BoardBlockInput[], zones: BoardZone[]): boolean => {
    const token = LOCAL_PREVIEW_ENABLED ? sessionStorage.getItem('filebox-local-token') : localStorage.getItem('token');
    const body = JSON.stringify({ rev, blocks, zones });
    if (!token || body.length > 60000) return false;
    try {
      fetch(`${API_URL}/workspace-boards/tabs/${tabId}/blocks`, { method: 'PUT', keepalive: true, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  },
};

// Advanced Search (server/services/advancedSearch.js). Every result, snippet and count comes from the
// server's permission-checked search; the page only shows what it is sent.
export interface FileClassification {
  primaryCategory: string;
  documentType: string;
  topics: string[];
  source: 'user' | 'rules' | 'profile' | 'default';
  canChange?: boolean;
}

export interface AdvancedSearchResult {
  _id: string;
  originalName: string;
  mimeType: string;
  size: number;
  technicalType: 'pdf' | 'image' | 'document' | 'text' | 'code' | 'other';
  createdAt: string;
  updatedAt: string;
  parentFolder: string | null;
  folderName: string | null;
  isStarred: boolean;
  ownerName: string | null;
  access: { role: 'owner' | 'editor' | 'viewer'; source: 'owned' | 'shared' | 'team'; teamName?: string };
  score: number;
  matchedTerms: string[];
  matchedIn: Array<'name' | 'content' | 'type' | 'category' | 'topic' | 'meaning'>;
  snippet: { text: string; highlights: Array<[number, number]>; source: string } | null;
  classification: FileClassification;
}

export interface SearchGroup { name: string; count: number }

export interface AdvancedSearchResponse {
  results: AdvancedSearchResult[];
  total: number;
  groups: { categories: SearchGroup[]; documentTypes: SearchGroup[] };
  applied: Record<string, unknown> & {
    terms: string[];
    text?: string;
    // What was read out of plain words ("invoices from September"), when the search asked for that.
    parsed?: { understood: Array<{ key: string; label: string }>; confidence: 'high' | 'low' | 'model'; vague: string; usedModel: boolean; cached: boolean; original: string };
    semantic?: { requested: string; used: boolean; added: number; reason: string; weak: boolean };
  };
}

export interface AdvancedSearchParams {
  q?: string;
  category?: string;
  documentType?: string;
  topic?: string;
  format?: string;
  date?: string;
  from?: string;
  to?: string;
  dateField?: string;
  location?: string;
  folderId?: string;
  // One Team Space (location 'team' only); without it, all of the person's Team Spaces.
  teamId?: string;
  currentFolderId?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  tz?: number;
  // 'rules' reads filters out of the words; 'model' may also ask the local model once (after Enter).
  parse?: 'off' | 'rules' | 'model';
  // 'on' only when the person asked to search by meaning.
  semantic?: 'on';
}

export const advancedSearchAPI = {
  search: async (params: AdvancedSearchParams, signal?: AbortSignal): Promise<AdvancedSearchResponse> => {
    const response = await api.get('/search/advanced', { params, signal });
    return response.data;
  },
  taxonomy: async (): Promise<{ categories: Array<{ name: string; documentTypes: string[] }> }> => {
    const response = await api.get('/search/taxonomy');
    return response.data;
  },
  // A person's own label for a file; { reset: true } goes back to the automatic one.
  setClassification: async (fileId: string, body: { primaryCategory: string; documentType: string } | { reset: true }): Promise<{ classification: FileClassification }> => {
    const response = await api.patch(`/search/classification/${fileId}`, body);
    return response.data;
  },
  reclassify: async (fileId: string): Promise<{ classification: FileClassification; profile: string }> => {
    const response = await api.post(`/search/classification/${fileId}/reclassify`);
    return response.data;
  },
};

// Relationships API
export const relationshipsAPI = {
  createRelationship: async (
    sourceFileId: string,
    targetFileId: string,
    relationshipType?: string,
    customLabel?: string,
    description?: string
  ) => {
    const response = await api.post('/relationships', {
      sourceFileId,
      targetFileId,
      relationshipType,
      customLabel,
      description,
    });
    return response.data;
  },
  getFileRelationships: async (fileId: string) => {
    const response = await api.get(`/relationships/file/${fileId}`);
    return response.data;
  },
  getRelationshipGraph: async () => {
    const response = await api.get('/relationships/graph', { timeout: 10000 });
    return response.data;
  },
  updateRelationship: async (relationshipId: string, data: { relationshipType?: string; customLabel?: string; description?: string }) => {
    const response = await api.put(`/relationships/${relationshipId}`, data);
    return response.data;
  },
  deleteRelationship: async (relationshipId: string) => {
    const response = await api.delete(`/relationships/${relationshipId}`);
    return response.data;
  },
  getSuggestions: async (fileId: string) => {
    const response = await api.get(`/relationships/suggestions/${fileId}`);
    return response.data;
  },
};

// Smart Organization API
export const smartOrgAPI = {
  analyzeFile: async (fileId: string) => {
    const response = await api.post(`/smart-org/analyze/${fileId}`);
    return response.data;
  },
  analyzeBulk: async (fileIds: string[]) => {
    const response = await api.post('/smart-org/analyze-bulk', { fileIds });
    return response.data;
  },
  getSuggestions: async (folderId?: string) => {
    const url = folderId ? `/smart-org/suggest/${folderId}` : '/smart-org/suggest';
    const response = await api.get(url);
    return response.data;
  },
  organizeFiles: async (folderName: string, fileIds: string[], parentFolderId?: string) => {
    const response = await api.post('/smart-org/organize', {
      folderName,
      fileIds,
      parentFolderId
    });
    return response.data;
  },
};

// Social API
export const socialAPI = {
  createPost: async (fileId?: string, folderId?: string, description?: string, isPublic?: boolean, groupId?: string) => {
    const response = await api.post('/social/post', { fileId, folderId, description, isPublic, groupId });
    return response.data;
  },
  getFeed: async (page: number = 1, limit: number = 20) => {
    const response = await api.get('/social/feed', { params: { page, limit } });
    return response.data;
  },
  getUserPosts: async (userId: string, page: number = 1, limit: number = 20) => {
    const response = await api.get(`/social/user/${userId}/posts`, { params: { page, limit } });
    return response.data;
  },
  likePost: async (postId: string) => {
    const response = await api.post(`/social/post/${postId}/like`);
    return response.data;
  },
  addComment: async (postId: string, text: string) => {
    const response = await api.post(`/social/post/${postId}/comment`, { text });
    return response.data;
  },
  deletePost: async (postId: string) => {
    const response = await api.delete(`/social/post/${postId}`);
    return response.data;
  },
  followUser: async (userId: string) => {
    const response = await api.post(`/social/follow/${userId}`);
    return response.data;
  },
  getFollowStatus: async (userId: string) => {
    const response = await api.get(`/social/follow/${userId}`);
    return response.data;
  },
  getUserStats: async (userId: string) => {
    const response = await api.get(`/social/user/${userId}/stats`);
    return response.data;
  },
  discoverUsers: async (limit: number = 10) => {
    const response = await api.get('/social/discover', { params: { limit } });
    return response.data;
  },
  repostPost: async (postId: string) => {
    const response = await api.post(`/social/post/${postId}/repost`);
    return response.data;
  },
  savePost: async (postId: string) => {
    const response = await api.post(`/social/post/${postId}/save`);
    return response.data;
  },
  getSavedPosts: async () => {
    const response = await api.get('/social/saved');
    return response.data;
  },
  searchUsers: async (query: string) => {
    const response = await api.get('/social/search/users', { params: { q: query } });
    return response.data;
  },
  getUserProfile: async (userId: string) => {
    const response = await api.get(`/social/user/${userId}/profile`);
    return response.data;
  },
  updateProfile: async (bio: string) => {
    const response = await api.patch('/social/profile', { bio });
    return response.data;
  },
  getNotifications: async (limit: number = 50) => {
    const response = await api.get('/social/notifications', { params: { limit } });
    return response.data;
  },
  markNotificationRead: async (notificationId: string) => {
    const response = await api.patch(`/social/notifications/${notificationId}/read`);
    return response.data;
  },
  markAllNotificationsRead: async () => {
    const response = await api.patch('/social/notifications/read-all');
    return response.data;
  },
};

export const groupsAPI = {
  createGroup: async (name: string, description: string, privacy: string = 'public') => {
    const response = await api.post('/groups', { name, description, privacy });
    return response.data;
  },
  getGroups: async (page: number = 1, limit: number = 20, search?: string) => {
    const response = await api.get('/groups', { params: { page, limit, search } });
    return response.data;
  },
  getGroup: async (groupId: string) => {
    const response = await api.get(`/groups/${groupId}`);
    return response.data;
  },
  joinGroup: async (groupId: string) => {
    const response = await api.post(`/groups/${groupId}/join`);
    return response.data;
  },
  leaveGroup: async (groupId: string) => {
    const response = await api.post(`/groups/${groupId}/leave`);
    return response.data;
  },
  getGroupPosts: async (groupId: string, page: number = 1, limit: number = 20) => {
    const response = await api.get(`/groups/${groupId}/posts`, { params: { page, limit } });
    return response.data;
  },
  addAdmin: async (groupId: string, userId: string) => {
    const response = await api.post(`/groups/${groupId}/admin/${userId}`, { action: 'add' });
    return response.data;
  },
  removeAdmin: async (groupId: string, userId: string) => {
    const response = await api.post(`/groups/${groupId}/admin/${userId}`, { action: 'remove' });
    return response.data;
  },
  requestToJoin: async (groupId: string, message?: string) => {
    const response = await api.post(`/groups/${groupId}/join`, { message });
    return response.data;
  },
  getJoinRequests: async (groupId: string) => {
    const response = await api.get(`/groups/${groupId}/requests`);
    return response.data;
  },
  acceptJoinRequest: async (groupId: string, requestId: string) => {
    const response = await api.post(`/groups/${groupId}/requests/${requestId}/accept`);
    return response.data;
  },
  rejectJoinRequest: async (groupId: string, requestId: string) => {
    const response = await api.post(`/groups/${groupId}/requests/${requestId}/reject`);
    return response.data;
  },
  inviteUsers: async (groupId: string, userIds: string[]) => {
    const response = await api.post(`/groups/${groupId}/invite`, { userIds });
    return response.data;
  },
  getMyJoinRequests: async () => {
    const response = await api.get('/groups/requests/my');
    return response.data;
  },
};

// Analytics API
export const analyticsAPI = {
  getAccessStats: async (timeRange: string = '30d') => {
    const response = await api.get('/analytics/access-stats', { params: { timeRange } });
    return response.data;
  },
  getHeatmap: async (timeRange: string = '30d') => {
    const response = await api.get('/analytics/heatmap', { params: { timeRange } });
    return response.data;
  },
  getUnusedFiles: async (daysUnused: number = 90) => {
    const response = await api.get('/analytics/unused-files', { params: { daysUnused } });
    return response.data;
  },
  getStorageBreakdown: async () => {
    const response = await api.get('/analytics/storage-breakdown');
    return response.data;
  },
  getActivityTimeline: async (timeRange: string = '7d') => {
    const response = await api.get('/analytics/timeline', { params: { timeRange } });
    return response.data;
  },
  getTopFileTypes: async (timeRange: string = '30d') => {
    const response = await api.get('/analytics/top-types', { params: { timeRange } });
    return response.data;
  },
  getSuggestions: async () => {
    const response = await api.get('/analytics/suggestions');
    return response.data;
  },
};

// Assignments API
export const assignmentsAPI = {
  getAssignments: async (params?: { status?: string; course?: string; upcoming?: boolean }) => {
    const response = await api.get('/assignments', { params });
    return response.data;
  },
  getAssignment: async (id: string) => {
    const response = await api.get(`/assignments/${id}`);
    return response.data;
  },
  createAssignment: async (data: any) => {
    const response = await api.post('/assignments', data);
    return response.data;
  },
  updateAssignment: async (id: string, data: any) => {
    const response = await api.put(`/assignments/${id}`, data);
    return response.data;
  },
  deleteAssignment: async (id: string) => {
    const response = await api.delete(`/assignments/${id}`);
    return response.data;
  },
  attachFile: async (assignmentId: string, fileId: string) => {
    const response = await api.post(`/assignments/${assignmentId}/attach-file`, { fileId });
    return response.data;
  },
  removeFile: async (assignmentId: string, fileId: string) => {
    const response = await api.delete(`/assignments/${assignmentId}/attach-file/${fileId}`);
    return response.data;
  },
};

// Courses API
export const coursesAPI = {
  getCourses: async (params?: { semester?: string; year?: number }) => {
    const response = await api.get('/courses', { params });
    return response.data;
  },
  getCourse: async (id: string) => {
    const response = await api.get(`/courses/${id}`);
    return response.data;
  },
  createCourse: async (data: any) => {
    const response = await api.post('/courses', data);
    return response.data;
  },
  updateCourse: async (id: string, data: any) => {
    const response = await api.put(`/courses/${id}`, data);
    return response.data;
  },
  deleteCourse: async (id: string) => {
    const response = await api.delete(`/courses/${id}`);
    return response.data;
  },
};

// Study Groups API
// File Memory API
// Predictive Organization API
export const predictiveOrgAPI = {
  getSuggestions: async (fileId: string, actionBefore?: string) => {
    const response = await api.get(`/predictive-org/suggestions/${fileId}`, {
      params: { actionBefore }
    });
    return response.data;
  },
  getPatterns: async () => {
    const response = await api.get('/predictive-org/patterns');
    return response.data;
  },
  recordFeedback: async (patternId: string, action: 'accepted' | 'rejected' | 'ignored') => {
    const response = await api.post(`/predictive-org/feedback/${patternId}`, { action });
    return response.data;
  },
};

export const fileMemoryAPI = {
  getFileMemory: async (fileId: string) => {
    const response = await api.get(`/file-memory/file/${fileId}`);
    return response.data;
  },
  updateFileMemory: async (fileId: string, data: {
    userAction?: string;
    projectContext?: string;
    meetingContext?: string;
    deadlineContext?: string;
    notes?: string;
  }) => {
    const response = await api.put(`/file-memory/file/${fileId}`, data);
    return response.data;
  },
  getAllMemories: async (params?: { project?: string; search?: string; sortBy?: string }) => {
    const response = await api.get('/file-memory', { params });
    return response.data;
  },
  askAboutFile: async (fileId: string, question: string) => {
    const response = await api.post(`/file-memory/file/${fileId}/ask`, { question });
    return response.data;
  },
  linkFile: async (fileId: string, data: {
    project?: string;
    courseId?: string;
    studyGroupId?: string;
    assignmentId?: string;
  }) => {
    const response = await api.post(`/file-memory/file/${fileId}/link`, data);
    return response.data;
  },
};

export const studyGroupsAPI = {
  getStudyGroups: async (params?: { courseCode?: string }) => {
    const response = await api.get('/study-groups', { params });
    return response.data;
  },
  getStudyGroup: async (id: string) => {
    const response = await api.get(`/study-groups/${id}`);
    return response.data;
  },
  createStudyGroup: async (data: any) => {
    const response = await api.post('/study-groups', data);
    return response.data;
  },
  joinStudyGroup: async (id: string) => {
    const response = await api.post(`/study-groups/${id}/join`);
    return response.data;
  },
  leaveStudyGroup: async (id: string) => {
    const response = await api.post(`/study-groups/${id}/leave`);
    return response.data;
  },
  updateStudyGroup: async (id: string, data: any) => {
    const response = await api.put(`/study-groups/${id}`, data);
    return response.data;
  },
  deleteStudyGroup: async (id: string) => {
    const response = await api.delete(`/study-groups/${id}`);
    return response.data;
  },
  inviteUser: async (groupId: string, userId: string, message?: string) => {
    const response = await api.post(`/study-groups/${groupId}/invite`, { userId, message });
    return response.data;
  },
  respondToInvitation: async (invitationId: string, action: 'accept' | 'reject') => {
    const response = await api.post(`/study-groups/invitations/${invitationId}/respond`, { action });
    return response.data;
  },
  getMyInvitations: async () => {
    const response = await api.get('/study-groups/invitations/my');
    return response.data;
  },
  getNotes: async (groupId: string) => {
    const response = await api.get(`/study-groups/${groupId}/notes`);
    return response.data;
  },
  createNote: async (groupId: string, data: any) => {
    const response = await api.post(`/study-groups/${groupId}/notes`, data);
    return response.data;
  },
  updateNote: async (noteId: string, data: any) => {
    const response = await api.put(`/study-groups/notes/${noteId}`, data);
    return response.data;
  },
  deleteNote: async (noteId: string) => {
    const response = await api.delete(`/study-groups/notes/${noteId}`);
    return response.data;
  },
  getFlashcards: async (groupId: string, deck?: string) => {
    const response = await api.get(`/study-groups/${groupId}/flashcards`, { params: { deck } });
    return response.data;
  },
  createFlashcard: async (groupId: string, data: any) => {
    const response = await api.post(`/study-groups/${groupId}/flashcards`, data);
    return response.data;
  },
  getWhiteboards: async (groupId: string) => {
    const response = await api.get(`/study-groups/${groupId}/whiteboards`);
    return response.data;
  },
  createWhiteboard: async (groupId: string, name?: string) => {
    const response = await api.post(`/study-groups/${groupId}/whiteboards`, { name });
    return response.data;
  },
  updateWhiteboard: async (whiteboardId: string, data: any) => {
    const response = await api.put(`/study-groups/whiteboards/${whiteboardId}`, data);
    return response.data;
  },
  getChatMessages: async (groupId: string, limit?: number) => {
    const response = await api.get(`/study-groups/${groupId}/chat`, { params: { limit } });
    return response.data;
  },
  sendChatMessage: async (groupId: string, message: string, type?: string, fileUrl?: string) => {
    const response = await api.post(`/study-groups/${groupId}/chat`, { message, type, fileUrl });
    return response.data;
  },
};

// Annotations API
export const annotationsAPI = {
  getAnnotations: async (fileId: string) => {
    const response = await api.get(`/annotations/file/${fileId}`);
    return response.data;
  },
  createAnnotation: async (data: any) => {
    const response = await api.post('/annotations', data);
    return response.data;
  },
  updateAnnotation: async (id: string, data: any) => {
    const response = await api.put(`/annotations/${id}`, data);
    return response.data;
  },
  deleteAnnotation: async (id: string) => {
    const response = await api.delete(`/annotations/${id}`);
    return response.data;
  },
};

// Calendar API
export const calendarAPI = {
  getEvents: async (params?: { startDate?: string; endDate?: string; type?: string; courseCode?: string }) => {
    const response = await api.get('/calendar', { params });
    return response.data;
  },
  getUpcomingEvents: async (limit?: number) => {
    const response = await api.get('/calendar/upcoming', { params: { limit } });
    return response.data;
  },
  getEvent: async (id: string) => {
    const response = await api.get(`/calendar/${id}`);
    return response.data;
  },
  createEvent: async (data: any) => {
    const response = await api.post('/calendar', data);
    return response.data;
  },
  updateEvent: async (id: string, data: any) => {
    const response = await api.put(`/calendar/${id}`, data);
    return response.data;
  },
  deleteEvent: async (id: string) => {
    const response = await api.delete(`/calendar/${id}`);
    return response.data;
  },
  syncAssignments: async () => {
    const response = await api.post('/calendar/sync-assignments');
    return response.data;
  },
};

// File Collections API
export const collectionsAPI = {
  getCollections: async (isPublic?: boolean) => {
    const response = await api.get('/collections', {
      params: isPublic ? { public: true } : {}
    });
    return response.data;
  },
  getCollection: async (id: string) => {
    const response = await api.get(`/collections/${id}`);
    return response.data;
  },
  createCollection: async (data: { name: string; description?: string; files?: any[]; isPublic?: boolean; tags?: string[] }) => {
    const response = await api.post('/collections', data);
    return response.data;
  },
  updateCollection: async (id: string, data: { name?: string; description?: string; files?: any[]; isPublic?: boolean; tags?: string[] }) => {
    const response = await api.put(`/collections/${id}`, data);
    return response.data;
  },
  addFileToCollection: async (collectionId: string, data: { fileId?: string; folderId?: string; note?: string }) => {
    const response = await api.post(`/collections/${collectionId}/files`, data);
    return response.data;
  },
  removeFileFromCollection: async (collectionId: string, fileIndex: number) => {
    const response = await api.delete(`/collections/${collectionId}/files/${fileIndex}`);
    return response.data;
  },
  deleteCollection: async (id: string) => {
    const response = await api.delete(`/collections/${id}`);
    return response.data;
  },
  likeCollection: async (id: string) => {
    const response = await api.post(`/collections/${id}/like`);
    return response.data;
  },
};

// File Summaries API
export const summariesAPI = {
  getSummary: async (fileId: string) => {
    const response = await api.get(`/summaries/file/${fileId}`);
    return response.data;
  },
  generateSummary: async (fileId: string) => {
    const response = await api.post(`/summaries/file/${fileId}`);
    return response.data;
  },
};

// Signatures API
export const signaturesAPI = {
  getSignatures: async () => {
    const response = await api.get('/signatures');
    return response.data;
  },
  getSignature: async (signatureId: string) => {
    const response = await api.get(`/signatures/${signatureId}`);
    return response.data;
  },
  createSignature: async (data: { name: string; signatureData: string; isDefault?: boolean }) => {
    const response = await api.post('/signatures', data);
    return response.data;
  },
  updateSignature: async (signatureId: string, data: { name?: string; isDefault?: boolean }) => {
    const response = await api.put(`/signatures/${signatureId}`, data);
    return response.data;
  },
  deleteSignature: async (signatureId: string) => {
    const response = await api.delete(`/signatures/${signatureId}`);
    return response.data;
  },
  // Pages of a PDF for placing a signature: sizes, then each page as an image (object URL).
  getPdfPages: async (fileId: string): Promise<{ total: number; pages: { width: number; height: number }[]; protected?: boolean; protectedMessage?: string }> => {
    const response = await api.get(`/signatures/document/${fileId}/pages`);
    return response.data;
  },
  getPdfPageImage: async (fileId: string, page: number): Promise<string> => {
    const response = await api.get(`/signatures/document/${fileId}/pages/${page}`, { responseType: 'blob' });
    return URL.createObjectURL(response.data);
  },
  /** Sign a PDF: position is the signature's top-left corner and width, as fractions of the page. */
  signPdf: async (fileId: string, data: { signatureId: string; pageNumber: number; position: { x: number; y: number; width: number } }) => {
    const response = await api.post(`/signatures/apply/${fileId}`, data);
    return response.data;
  },
  applySignature: async (fileId: string, data: { signatureId: string; pageNumber: number; position: { x: number; y: number; width: number; height: number } }) => {
    const response = await api.post(`/signatures/apply/${fileId}`, data);
    return response.data;
  },
  getDocumentSignatures: async (fileId: string) => {
    const response = await api.get(`/signatures/document/${fileId}`);
    return response.data;
  },
};

// Home overview (local data only; works when File Box AI is offline)
export interface HomeSuggestion {
  id: string;
  fingerprint: string;
  noticed: string;
  why: string;
  recommendation: string;
  action: { label: string; type: 'navigate' | 'duplicates' | 'organize'; to?: string };
}
export interface HomeActivity {
  _id: string;
  action: string;
  source: 'user' | 'filebox';
  details: string;
  fileName: string | null;
  folderName: string | null;
  createdAt: string;
  count: number;
}
export interface HomeOverview {
  continueWorking: any[];
  suggestions: HomeSuggestion[];
  suggestionsAvailable: number;
  activity: HomeActivity[];
}

export const homeAPI = {
  getOverview: async (): Promise<HomeOverview> => {
    const response = await api.get('/home');
    return response.data;
  },
  getDay: async (date?: string): Promise<DayOverview> => {
    const response = await api.get('/home/day', { params: { date, tz: new Date().getTimezoneOffset() } });
    return response.data;
  },
  // Starts writing the day's summary in the background; getDay reports it when ready.
  writeDaySummary: async (date: string, force = false): Promise<{ writing: boolean }> => {
    const response = await api.post('/home/day/summary', { date, force, tz: new Date().getTimezoneOffset() });
    return response.data;
  },
};

// "Your day" on Home: what was done in File Box on a date and File Box AI's summary of it.
export interface DayFile {
  fileId: string;
  name: string;
  kind: string;
  about: string;
  exists: boolean;
  parentFolder: string | null;
  minutes: number;
  actions: Record<string, number>;
  firstAt: string;
  lastAt: string;
}
export interface DayFacts {
  date: string;
  totals: { activeMinutes: number; filesWorkedOn: number; uploaded: number; edited: number; viewed: number; downloaded: number; shared: number; organized: number; questions: number };
  files: DayFile[];
  questions: { question: string; at: string }[];
  folders: { action: string; name: string; at: string }[];
  fileboxActions: number;
  timeline: { hour: number; items: string[] }[];
  empty: boolean;
}
export interface DaySummary {
  summary: string;
  highlights: string[];
  suggestions: string[];
  basic: boolean;
  generatedAt?: string;
}
export interface DayOverview {
  facts: DayFacts;
  summary: DaySummary | null;
  writing: boolean;
  days: { date: string; count: number }[];
}

export const preferencesAPI = {
  get: async (): Promise<{ accentColor: string | null; appearance: unknown | null }> => {
    const response = await api.get('/users/preferences');
    return response.data;
  },
  setAppearance: async (appearance: unknown): Promise<{ appearance: unknown }> => {
    const response = await api.put('/users/preferences', { appearance });
    return response.data;
  },
  getBackground: async (): Promise<{ image: string | null }> => {
    const response = await api.get('/users/preferences/background');
    return response.data;
  },
  setBackground: async (image: string | null): Promise<void> => {
    await api.put('/users/preferences/background', { image });
  },
  setAccent: async (accentColor: string | null): Promise<{ accentColor: string | null }> => {
    const response = await api.put('/users/preferences', { accentColor });
    return response.data;
  },
};

// My Files > Board: a person's own layout for a folder (where items sit, and the zones they drew).
export type BoardZoneShape = 'rectangle' | 'rounded' | 'circle' | 'pill';
// labelX/labelY: where the zone's name sits inside it (left out = the shape's usual spot).
export interface BoardZone { id: string; name: string; color: string; shape: BoardZoneShape; x: number; y: number; w: number; h: number; labelX?: number; labelY?: number }
export interface BoardLayout { items: Record<string, { x: number; y: number }>; zones: BoardZone[] }

export const boardsAPI = {
  get: async (folderKey: string): Promise<BoardLayout> => {
    const response = await api.get(`/boards/${folderKey}`);
    return response.data;
  },
  save: async (folderKey: string, layout: BoardLayout): Promise<BoardLayout> => {
    const response = await api.put(`/boards/${folderKey}`, layout);
    return response.data;
  },
};

export const activityAPI = {
  focus: async (fileId: string, seconds: number) => {
    await api.post('/activity/focus', { fileId, seconds });
  },
};

// AI Assistant API (local Ollama)
export type AssistantHistoryMessage = { role: 'user' | 'assistant'; content: string };
// Choices made from a "which one do you mean?" list, sent back with the original request.
export type AssistantResolved = { files?: Record<string, string>; folder?: string; route?: Record<string, unknown> };
export interface AssistantChoice {
  id: string;
  kind: 'file' | 'folder';
  name: string;
  location: string;
  source: 'owned' | 'shared' | 'team';
  sourceLabel: string;
  updatedAt?: string;
}

// File Box AI as a companion: its name, tone, how often it speaks up, and what it remembers.
export type CompanionTone = 'friendly' | 'concise' | 'professional' | 'playful';
export type CompanionProactivity = 'quiet' | 'balanced' | 'chatty';
export interface CompanionMemory { id: string; text: string; createdAt: string }
export interface CompanionProfile { name: string; tone: CompanionTone; proactivity: CompanionProactivity; memoryOn: boolean; screenAware: boolean; memories: CompanionMemory[] }

// Something Ask File Box noticed about the current file, folder or selection (rules and stored data only).
export interface CompanionSuggestion {
  key: string;
  type: string;
  kind: 'problem' | 'insight' | 'organize' | 'continue';
  text: string;
  action: { label: string; text?: string; mode?: 'send' | 'prefill'; open?: { fileId: string; name: string; parentFolder: string | null } };
}

export const companionAPI = {
  get: async (): Promise<CompanionProfile> => (await api.get('/companion')).data,
  update: async (settings: Partial<Omit<CompanionProfile, 'memories'>>): Promise<CompanionProfile> => (await api.put('/companion', settings)).data,
  remember: async (text: string): Promise<CompanionProfile> => (await api.post('/companion/memories', { text })).data,
  forget: async (id: string): Promise<CompanionProfile> => (await api.delete(`/companion/memories/${id}`)).data,
  forgetAll: async (): Promise<CompanionProfile> => (await api.delete('/companion/memories')).data,
  suggestions: async (focus: { fileId?: string; fileIds?: string[]; folderId?: string }): Promise<{ subject: string; suggestions: CompanionSuggestion[] }> =>
    (await api.get('/companion/suggestions', { params: { fileId: focus.fileId, folderId: focus.folderId, fileIds: focus.fileIds?.length ? focus.fileIds.join(',') : undefined } })).data,
};

// What Ask File Box is looking at, sent with each question (ids are re-checked on the server).
export interface AssistantFocus { fileId?: string; fileIds?: string[]; folderId?: string; page?: string }

// Screen awareness for one question: which kind of view it is about, the PDF page, and (only when the
// question needs to see the interface) a screenshot of the visible File Box app, sent once and not kept.
export interface AssistantScreen { fingerprint: string; kind: 'pdf' | 'image' | 'ui'; pdfPage?: number; image?: string; explicit?: boolean; captureFailed?: boolean }

export const aiAssistantAPI = {
  chat: async (question: string, fileId?: string, context?: string, history?: AssistantHistoryMessage[], resolved?: AssistantResolved) => {
    const response = await api.post('/ai-assistant/chat', { question, fileId, context, history, resolved });
    return response.data;
  },
  /**
   * Same as chat, but the answer arrives piece by piece (onToken) while File Box AI writes it.
   * Resolves with the full reply; errors carry `response.data` like axios errors.
   */
  chatStream: async (
    body: { question: string; fileId?: string; history?: AssistantHistoryMessage[]; resolved?: AssistantResolved; context?: string; focus?: AssistantFocus; screen?: AssistantScreen },
    onToken: (text: string) => void,
    onReset?: () => void,
  ) => {
    const token = await currentToken('/ai-assistant/chat');
    const response = await fetch(`${API_URL}/ai-assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...body, stream: true }),
    });
    const fail = (status: number, data: any) => Object.assign(new Error(data?.message || 'File Box AI could not answer.'), { response: { status, data } });
    if (!response.ok || !response.body) throw fail(response.status, await response.json().catch(() => ({})));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'token') onToken(event.text);
        else if (event.type === 'reset') onReset?.();
        else if (event.type === 'done') return event.reply;
        else if (event.type === 'error') throw fail(event.status, event.body);
      }
    }
    throw fail(500, { message: 'File Box AI stopped before finishing the answer.' });
  },
  presence: async () => {
    await api.post('/ai-assistant/presence');
  },
  feedback: async (body: {
    question: string; answer: string; rating: 'up' | 'down'; intent?: string; action?: string; phrase?: string;
    shownFileIds?: string[]; correctFileId?: string; note?: string;
  }): Promise<{ ok: boolean; learned: boolean }> => {
    const response = await api.post('/ai-assistant/feedback', body);
    return response.data;
  },
  readingStatus: async (): Promise<{ total: number; done: number; pending: number }> => {
    const response = await api.get('/ai-assistant/reading-status');
    return response.data;
  },
  confirmAction: async (action: { type: string; question: string; fileId?: string | null; fileIds?: string[] }) => {
    const response = await api.post('/ai-assistant/confirm', { ...action, fileId: action.fileId || undefined });
    return response.data;
  },
  getStatus: async () => {
    const response = await api.get('/ai-assistant/status');
    return response.data;
  },
  getFileInsights: async (fileId: string) => {
    const response = await api.get(`/ai-assistant/insights/${fileId}`);
    return response.data;
  },
  getFileActions: async (fileId: string): Promise<FileAIActionsInfo> => {
    const response = await api.get(`/ai-assistant/file-actions/${fileId}`);
    return response.data;
  },
  runFileAction: async (fileId: string, action: string): Promise<{ action: string; result: string; provider: string; truncated?: boolean }> => {
    const response = await api.post(`/ai-assistant/file-actions/${fileId}`, { action });
    return response.data;
  },
  getDuplicates: async (explain = false): Promise<DuplicateSuggestions> => {
    const response = await api.get('/ai-assistant/duplicates', { params: explain ? { explain: 1 } : {} });
    return response.data;
  },
  suggestOrganization: async (folderId?: string | null): Promise<OrganizeSuggestions> => {
    const response = await api.post('/ai-assistant/organize/suggest', { folderId: folderId || undefined });
    return response.data;
  },
  applyOrganization: async (actions: OrganizeProposal[]) => {
    const response = await api.post('/ai-assistant/organize/apply', { actions, confirm: true });
    return response.data as { applied: number; failed: number; results: Array<{ id: string; success: boolean; message: string }> };
  },
};

export interface FileAIAction { id: string; label: string; needsAI: boolean; available: boolean }
export interface FileAIActionsInfo { kind: string; aiReady: boolean; actions: FileAIAction[]; canAsk: boolean }

export interface DuplicateCopy {
  _id: string;
  originalName: string;
  size: number;
  parentFolder: string | null;
  location: string;
  updatedAt: string;
  createdAt: string;
  reasons: string[];
  suggested: 'keep' | 'remove' | null;
}
export interface DuplicateGroup { size: number; reclaimableBytes: number; why: string; confident: boolean; keepId: string | null; note: string; copies: DuplicateCopy[] }
export interface DuplicateSuggestions { groups: DuplicateGroup[]; complete: boolean; reclaimableBytes: number; explanation: string | null }

export interface OrganizeProposal {
  id: string;
  type: 'move' | 'rename';
  fileId: string;
  fileName?: string;
  currentLocation?: string;
  folderId?: string | null;
  folderName?: string;
  isNewFolder?: boolean;
  newName?: string;
  reason?: string;
  source?: 'rule' | 'ai';
  scopeFolderId?: string | null;
}
export interface OrganizeSuggestions { scope: { folderId: string | null; name: string }; fileCount: number; aiUsed: boolean; aiError: string; proposals: OrganizeProposal[] }

// Templates API
export const templatesAPI = {
  getTemplates: async (params?: { category?: string; search?: string; tags?: string[] }) => {
    const response = await api.get('/templates', { params });
    return response.data;
  },
  getTemplate: async (id: string) => {
    const response = await api.get(`/templates/${id}`);
    return response.data;
  },
  createTemplate: async (data: { name: string; description?: string; category?: string; content?: string; tags?: string[]; isPublic?: boolean; mimeType?: string }) => {
    const response = await api.post('/templates', data);
    return response.data;
  },
  createTemplateFromFile: async (fileId: string, data: { name?: string; description?: string; category?: string; tags?: string[]; isPublic?: boolean }) => {
    const response = await api.post(`/templates/create-from-file/${fileId}`, data);
    return response.data;
  },
  useTemplate: async (templateId: string, data: { fileName?: string; parentFolder?: string }) => {
    const response = await api.post(`/templates/${templateId}/use`, data);
    return response.data;
  },
  updateTemplate: async (id: string, data: { name?: string; description?: string; category?: string; content?: string; tags?: string[]; isPublic?: boolean }) => {
    const response = await api.put(`/templates/${id}`, data);
    return response.data;
  },
  rateTemplate: async (id: string, rating: number) => {
    const response = await api.post(`/templates/${id}/rate`, { rating });
    return response.data;
  },
  deleteTemplate: async (id: string) => {
    const response = await api.delete(`/templates/${id}`);
    return response.data;
  },
};

// Secured Links API
export const securedLinksAPI = {
  getSecuredLinks: async (params?: { category?: string; starred?: boolean; tags?: string[]; search?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.append('category', params.category);
    if (params?.starred) queryParams.append('starred', 'true');
    if (params?.tags) params.tags.forEach(tag => queryParams.append('tags', tag));
    if (params?.search) queryParams.append('search', params.search);
    
    const queryString = queryParams.toString();
    const url = queryString ? `/secured-links?${queryString}` : '/secured-links';
    const response = await api.get(url);
    return response.data;
  },
  getSecuredLink: async (id: string) => {
    const response = await api.get(`/secured-links/${id}`);
    return response.data;
  },
  createSecuredLink: async (data: {
    title: string;
    url: string;
    description?: string;
    category?: string;
    tags?: string[];
    password?: string;
    passwordHint?: string;
    isPasswordProtected?: boolean;
    isEncrypted?: boolean;
    notes?: string;
    expiresAt?: string;
  }) => {
    const response = await api.post('/secured-links', data);
    return response.data;
  },
  updateSecuredLink: async (id: string, data: {
    title?: string;
    url?: string;
    description?: string;
    category?: string;
    tags?: string[];
    password?: string;
    passwordHint?: string;
    isPasswordProtected?: boolean;
    isEncrypted?: boolean;
    notes?: string;
    isStarred?: boolean;
    expiresAt?: string;
  }) => {
    const response = await api.put(`/secured-links/${id}`, data);
    return response.data;
  },
  deleteSecuredLink: async (id: string) => {
    const response = await api.delete(`/secured-links/${id}`);
    return response.data;
  },
  accessSecuredLink: async (id: string, password?: string) => {
    const response = await api.post(`/secured-links/${id}/access`, { password });
    return response.data;
  },
  toggleStar: async (id: string) => {
    const response = await api.patch(`/secured-links/${id}/star`);
    return response.data;
  },
};

// Web Shortcuts API
export const webShortcutsAPI = {
  getShortcuts: async (params?: { folder?: string; starred?: boolean; tags?: string[]; search?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.folder !== undefined) queryParams.append('folder', params.folder || 'null');
    if (params?.starred) queryParams.append('starred', 'true');
    if (params?.tags) params.tags.forEach(tag => queryParams.append('tags', tag));
    if (params?.search) queryParams.append('search', params.search);
    
    const queryString = queryParams.toString();
    const url = queryString ? `/web-shortcuts?${queryString}` : '/web-shortcuts';
    const response = await api.get(url);
    return response.data;
  },
  getShortcut: async (id: string) => {
    const response = await api.get(`/web-shortcuts/${id}`);
    return response.data;
  },
  createShortcut: async (data: {
    title?: string;
    url: string;
    description?: string;
    tags?: string[];
    folder?: string;
    favicon?: string;
  }) => {
    const response = await api.post('/web-shortcuts', data);
    return response.data;
  },
  updateShortcut: async (id: string, data: {
    title?: string;
    url?: string;
    description?: string;
    tags?: string[];
    folder?: string;
    isStarred?: boolean;
    favicon?: string;
  }) => {
    const response = await api.put(`/web-shortcuts/${id}`, data);
    return response.data;
  },
  deleteShortcut: async (id: string) => {
    const response = await api.delete(`/web-shortcuts/${id}`);
    return response.data;
  },
  trackAccess: async (id: string) => {
    const response = await api.post(`/web-shortcuts/${id}/access`);
    return response.data;
  },
};

// Cloud Backup API
export const cloudBackupAPI = {
  getBackups: async () => {
    const response = await api.get('/cloud-backup');
    return response.data;
  },
  getDefaultPaths: async () => {
    const response = await api.get('/cloud-backup/default-paths');
    return response.data;
  },
  createBackup: async (data: {
    sourceType: 'desktop' | 'documents' | 'custom';
    sourcePath: string;
    enabled?: boolean;
    backupFrequency?: 'hourly' | 'daily' | 'weekly';
  }) => {
    const response = await api.post('/cloud-backup', data);
    return response.data;
  },
  updateBackup: async (backupId: string, data: {
    enabled?: boolean;
    backupFrequency?: 'hourly' | 'daily' | 'weekly';
  }) => {
    const response = await api.put(`/cloud-backup/${backupId}`, data);
    return response.data;
  },
  deleteBackup: async (backupId: string) => {
    const response = await api.delete(`/cloud-backup/${backupId}`);
    return response.data;
  },
  performBackup: async (backupId: string) => {
    const response = await api.post(`/cloud-backup/${backupId}/backup`);
    return response.data;
  },
};

// Integrations API
export const integrationsAPI = {
  getIntegrations: async () => {
    const response = await api.get('/integrations');
    return response.data;
  },
  getAuthUrl: async (provider: 'microsoft_teams' | 'zoom' | 'slack') => {
    // Convert provider name to match backend route format
    const routeProvider = provider === 'microsoft_teams' ? 'microsoft-teams' : provider;
    const response = await api.get(`/integrations/${routeProvider}/auth`);
    return response.data;
  },
  connectMicrosoftTeams: async (data: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    userId?: string;
    email?: string;
  }) => {
    const response = await api.post('/integrations/microsoft-teams/connect', data);
    return response.data;
  },
  connectZoom: async (data: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    userId?: string;
    email?: string;
  }) => {
    const response = await api.post('/integrations/zoom/connect', data);
    return response.data;
  },
  connectSlack: async (data: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    userId?: string;
    email?: string;
    teamId?: string;
  }) => {
    const response = await api.post('/integrations/slack/connect', data);
    return response.data;
  },
  disconnectIntegration: async (integrationId: string) => {
    const response = await api.delete(`/integrations/${integrationId}`);
    return response.data;
  },
  shareFile: async (integrationId: string, data: {
    fileId: string;
    channel?: string;
    message?: string;
  }) => {
    const response = await api.post(`/integrations/${integrationId}/share`, data);
    return response.data;
  },
};

// Forums API
export const forumsAPI = {
  getPosts: async (params?: {
    category?: string;
    search?: string;
    sortBy?: string;
    order?: string;
  }) => {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.append('category', params.category);
    if (params?.search) queryParams.append('search', params.search);
    if (params?.sortBy) queryParams.append('sortBy', params.sortBy);
    if (params?.order) queryParams.append('order', params.order);
    
    const queryString = queryParams.toString();
    const response = await api.get(`/forums${queryString ? `?${queryString}` : ''}`);
    return response.data;
  },
  getPost: async (postId: string) => {
    const response = await api.get(`/forums/${postId}`);
    return response.data;
  },
  createPost: async (data: {
    title: string;
    content: string;
    category?: string;
    tags?: string[];
  }) => {
    const response = await api.post('/forums', data);
    return response.data;
  },
  updatePost: async (postId: string, data: {
    title?: string;
    content?: string;
    tags?: string[];
  }) => {
    const response = await api.put(`/forums/${postId}`, data);
    return response.data;
  },
  deletePost: async (postId: string) => {
    const response = await api.delete(`/forums/${postId}`);
    return response.data;
  },
  replyToPost: async (postId: string, content: string) => {
    const response = await api.post(`/forums/${postId}/reply`, { content });
    return response.data;
  },
  voteOnPost: async (postId: string, vote: 'up' | 'down') => {
    const response = await api.post(`/forums/${postId}/vote`, { vote });
    return response.data;
  },
};

// Learning API
export const learningAPI = {
  getResources: async (params?: {
    category?: string;
    type?: string;
    difficulty?: string;
    search?: string;
    tags?: string[];
  }) => {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.append('category', params.category);
    if (params?.type) queryParams.append('type', params.type);
    if (params?.difficulty) queryParams.append('difficulty', params.difficulty);
    if (params?.search) queryParams.append('search', params.search);
    if (params?.tags) {
      params.tags.forEach(tag => queryParams.append('tags', tag));
    }
    
    const queryString = queryParams.toString();
    const response = await api.get(`/learning${queryString ? `?${queryString}` : ''}`);
    return response.data;
  },
  getResource: async (resourceId: string) => {
    const response = await api.get(`/learning/${resourceId}`);
    return response.data;
  },
  rateResource: async (resourceId: string, rating: number) => {
    const response = await api.post(`/learning/${resourceId}/rate`, { rating });
    return response.data;
  },
};

// Course Notes API
export const courseNotesAPI = {
  getNotes: async (courseId: string) => {
    const response = await api.get(`/course-notes/course/${courseId}`);
    return response.data;
  },
  getNote: async (noteId: string) => {
    const response = await api.get(`/course-notes/${noteId}`);
    return response.data;
  },
  createNote: async (data: {
    course: string;
    title: string;
    content?: string;
    tags?: string[];
    topic?: string;
    relatedFiles?: string[];
    isPinned?: boolean;
  }) => {
    const response = await api.post('/course-notes', data);
    return response.data;
  },
  updateNote: async (noteId: string, data: {
    title?: string;
    content?: string;
    tags?: string[];
    topic?: string;
    relatedFiles?: string[];
    isPinned?: boolean;
  }) => {
    const response = await api.put(`/course-notes/${noteId}`, data);
    return response.data;
  },
  deleteNote: async (noteId: string) => {
    const response = await api.delete(`/course-notes/${noteId}`);
    return response.data;
  },
  searchNotes: async (courseId: string, params?: { q?: string; tag?: string; topic?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.q) queryParams.append('q', params.q);
    if (params?.tag) queryParams.append('tag', params.tag);
    if (params?.topic) queryParams.append('topic', params.topic);
    const queryString = queryParams.toString();
    const response = await api.get(`/course-notes/search/${courseId}${queryString ? `?${queryString}` : ''}`);
    return response.data;
  },
};

// Study Schedule API
export const studyScheduleAPI = {
  getSchedules: async (courseId: string, params?: { startDate?: string; endDate?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.startDate) queryParams.append('startDate', params.startDate);
    if (params?.endDate) queryParams.append('endDate', params.endDate);
    const queryString = queryParams.toString();
    const response = await api.get(`/study-schedule/course/${courseId}${queryString ? `?${queryString}` : ''}`);
    return response.data;
  },
  getSchedule: async (scheduleId: string) => {
    const response = await api.get(`/study-schedule/${scheduleId}`);
    return response.data;
  },
  createSchedule: async (data: {
    course: string;
    title: string;
    description?: string;
    startTime: string;
    endTime: string;
    type?: string;
    location?: string;
    isRecurring?: boolean;
    recurringPattern?: any;
    reminderMinutes?: number;
  }) => {
    const response = await api.post('/study-schedule', data);
    return response.data;
  },
  updateSchedule: async (scheduleId: string, data: {
    title?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    type?: string;
    location?: string;
    isRecurring?: boolean;
    recurringPattern?: any;
    completed?: boolean;
    reminderMinutes?: number;
  }) => {
    const response = await api.put(`/study-schedule/${scheduleId}`, data);
    return response.data;
  },
  deleteSchedule: async (scheduleId: string) => {
    const response = await api.delete(`/study-schedule/${scheduleId}`);
    return response.data;
  },
};

// Progress Tracking API
export const progressTrackingAPI = {
  getProgress: async (courseId: string) => {
    const response = await api.get(`/progress-tracking/course/${courseId}`);
    return response.data;
  },
  getEntry: async (entryId: string) => {
    const response = await api.get(`/progress-tracking/${entryId}`);
    return response.data;
  },
  createEntry: async (data: {
    course: string;
    assignmentName: string;
    pointsEarned?: number;
    pointsPossible: number;
    category?: string;
    weight?: number;
    dateCompleted?: string;
    notes?: string;
  }) => {
    const response = await api.post('/progress-tracking', data);
    return response.data;
  },
  updateEntry: async (entryId: string, data: {
    assignmentName?: string;
    pointsEarned?: number;
    pointsPossible?: number;
    category?: string;
    weight?: number;
    dateCompleted?: string;
    notes?: string;
  }) => {
    const response = await api.put(`/progress-tracking/${entryId}`, data);
    return response.data;
  },
  deleteEntry: async (entryId: string) => {
    const response = await api.delete(`/progress-tracking/${entryId}`);
    return response.data;
  },
};

// Study Sessions API
export const studySessionsAPI = {
  getSessions: async (courseId: string, params?: { startDate?: string; endDate?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.startDate) queryParams.append('startDate', params.startDate);
    if (params?.endDate) queryParams.append('endDate', params.endDate);
    const queryString = queryParams.toString();
    const response = await api.get(`/study-sessions/course/${courseId}${queryString ? `?${queryString}` : ''}`);
    return response.data;
  },
  startSession: async (data: {
    course: string;
    topic?: string;
    filesAccessed?: string[];
  }) => {
    const response = await api.post('/study-sessions/start', data);
    return response.data;
  },
  endSession: async (sessionId: string, data?: {
    notes?: string;
    productivity?: string;
    notesCreated?: number;
  }) => {
    const response = await api.put(`/study-sessions/${sessionId}/end`, data || {});
    return response.data;
  },
  updateSession: async (sessionId: string, data: {
    topic?: string;
    filesAccessed?: string[];
    notes?: string;
    productivity?: string;
    notesCreated?: number;
  }) => {
    const response = await api.put(`/study-sessions/${sessionId}`, data);
    return response.data;
  },
  deleteSession: async (sessionId: string) => {
    const response = await api.delete(`/study-sessions/${sessionId}`);
    return response.data;
  },
};

export default api;
