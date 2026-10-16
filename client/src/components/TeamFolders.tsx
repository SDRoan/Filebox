import React, { useState, useEffect } from 'react';
import { teamFoldersAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import TeamFolderChat from './TeamFolderChat';
import './TeamFolders.css';

interface TeamMember {
  user: {
    _id: string;
    name: string;
    email: string;
  };
  role: 'admin' | 'editor' | 'viewer';
  joinedAt: string;
}

interface TeamFolder {
  _id: string;
  name: string;
  owner: {
    name: string;
    email: string;
  };
  members: TeamMember[];
  createdAt: string;
}

interface TeamFoldersProps {
  onClose: () => void;
  embedded?: boolean;
  onFolderSelect: (folderId: string) => void;
}

const TeamFolders: React.FC<TeamFoldersProps> = ({ onClose, onFolderSelect, embedded = false }) => {
  const { user } = useAuth();
  const [teamFolders, setTeamFolders] = useState<TeamFolder[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<TeamFolder | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<'admin' | 'editor' | 'viewer'>('viewer');
  const [memberError, setMemberError] = useState('');
  const [loading, setLoading] = useState(true);
  const [folderSearchQuery, setFolderSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'members'>('date');
  const [showFolderMenu, setShowFolderMenu] = useState<string | null>(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [folderStats, setFolderStats] = useState<{ [key: string]: { fileCount: number; totalSize: number } }>({});
  const [showChat, setShowChat] = useState(false);
  const [chatFolderId, setChatFolderId] = useState<string | null>(null);
  const [chatFolderName, setChatFolderName] = useState<string>('');

  useEffect(() => {
    loadTeamFolders();
  }, []);

  useEffect(() => {
    // Load stats for each folder
    teamFolders.forEach(folder => {
      loadFolderStats(folder._id);
    });
  }, [teamFolders]);

  const loadFolderStats = async (folderId: string) => {
    try {
      const data = await teamFoldersAPI.getTeamFolderFiles(folderId);
      const fileCount = (data.files?.length || 0) + (data.folders?.length || 0);
      const totalSize = data.files?.reduce((sum: number, f: any) => sum + (f.size || 0), 0) || 0;
      setFolderStats(prev => ({ ...prev, [folderId]: { fileCount, totalSize } }));
    } catch (error) {
      console.error('Error loading folder stats:', error);
    }
  };

  const loadTeamFolders = async () => {
    try {
      setLoading(true);
      const data = await teamFoldersAPI.getTeamFolders();
      setTeamFolders(data);
    } catch (error) {
      console.error('Error loading team folders:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;

    try {
      await teamFoldersAPI.createTeamFolder(newFolderName.trim());
      setNewFolderName('');
      setShowCreateModal(false);
      loadTeamFolders();
    } catch (error) {
      alert('Failed to create Team Space');
    }
  };

  // Members are added by exact email; File Box has no user directory.
  const handleAddMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedFolder || !searchQuery.trim()) return;
    setMemberError('');
    try {
      const updated = await teamFoldersAPI.addMember(selectedFolder._id, searchQuery.trim(), newMemberRole);
      setSelectedFolder(updated);
      setSearchQuery('');
      setNewMemberRole('viewer');
      loadTeamFolders();
    } catch (error: any) {
      setMemberError(error?.response?.data?.message || 'Could not add this person.');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedFolder) return;
    if (!window.confirm('Remove this member?')) return;

    try {
      await teamFoldersAPI.removeMember(selectedFolder._id, userId);
      setSelectedFolder({ ...selectedFolder, members: selectedFolder.members.filter(m => m.user._id !== userId) });
      loadTeamFolders();
    } catch (error) {
      alert('Failed to remove member');
    }
  };

  const handleChangeRole = async (userId: string, newRole: 'admin' | 'editor' | 'viewer') => {
    if (!selectedFolder) return;
    try {
      const updated = await teamFoldersAPI.setMemberRole(selectedFolder._id, userId, newRole);
      setSelectedFolder(updated);
      loadTeamFolders();
    } catch (error) {
      alert('Failed to change role');
    }
  };

  const handleRenameFolder = async () => {
    if (!selectedFolder || !renameValue.trim()) return;
    try {
      await teamFoldersAPI.renameTeamFolder(selectedFolder._id, renameValue.trim());
      setShowRenameModal(false);
      setRenameValue('');
      loadTeamFolders();
    } catch (error) {
      alert('Failed to rename folder');
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    if (!window.confirm('Delete this Team Space? All files and folders inside are permanently deleted for every member. This cannot be undone.')) {
      return;
    }
    try {
      await teamFoldersAPI.deleteTeamFolder(folderId);
      setShowFolderMenu(null);
      loadTeamFolders();
    } catch (error: any) {
      console.error('Error deleting team folder:', error);
      alert(error.response?.data?.message || 'Failed to delete team folder');
    }
  };

  const handleLeaveFolder = async (folderId: string) => {
    if (!user || !window.confirm('Leave this Team Space? You will lose access to its files until someone adds you again.')) return;
    try {
      await teamFoldersAPI.removeMember(folderId, user.id);
      loadTeamFolders();
    } catch (error: any) {
      alert(error?.response?.data?.message || 'Failed to leave this Team Space');
    }
  };

  // Filter and sort folders
  const filteredAndSortedFolders = teamFolders
    .filter(folder => {
      if (!folderSearchQuery) return true;
      const query = folderSearchQuery.toLowerCase();
      return folder.name.toLowerCase().includes(query) ||
        folder.owner.name.toLowerCase().includes(query) ||
        folder.owner.email.toLowerCase().includes(query);
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'members':
          return b.members.length - a.members.length;
        case 'date':
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const getUserInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const canManageMembers = (folder: TeamFolder) =>
    folder.owner.email === user?.email ||
    folder.members.some(m => m.user.email === user?.email && m.role === 'admin');

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin': return '#3f6543';
      case 'editor': return '#5f7fa3';
      case 'viewer': return '#9aa58f';
      default: return '#9aa58f';
    }
  };

  const isOwner = (folder: TeamFolder) => {
    return folder.owner.email === user?.email;
  };

  const getUserRole = (folder: TeamFolder) => {
    if (isOwner(folder)) return 'owner';
    const member = folder.members.find(m => m.user.email === user?.email);
    return member?.role || null;
  };

  return (
    <div className={embedded ? "team-folders-page" : "modal-overlay"} onClick={embedded ? undefined : onClose}>
      <div className="modal-content team-folders-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Team Spaces</h2>
          {!embedded && <button onClick={onClose} className="close-btn">×</button>}
        </div>

        <div className="team-folders-actions">
          <div className="team-folders-header-controls">
            <div className="search-box-team">
              <input
                type="text"
                placeholder="Search Team Spaces..."
                value={folderSearchQuery}
                onChange={(e) => setFolderSearchQuery(e.target.value)}
                className="search-input-team"
              />
              <span className="search-icon-team"></span>
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="sort-select-team"
            >
              <option value="date">Sort by Date</option>
              <option value="name">Sort by Name</option>
              <option value="members">Sort by Members</option>
            </select>
            <button onClick={() => setShowCreateModal(true)} className="action-button">
              + New Team Space
            </button>
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading...</div>
        ) : (
          <div className="team-folders-list">
            {filteredAndSortedFolders.length === 0 ? (
              <div className="empty-state">
                {folderSearchQuery ? 'No Team Spaces match your search' : 'No Team Spaces yet. Create one to share a folder with your team.'}
              </div>
            ) : (
              filteredAndSortedFolders.map((folder) => {
                const stats = folderStats[folder._id];
                const userRole = getUserRole(folder);
                const isFolderOwner = isOwner(folder);
                
                return (
                  <div
                    key={folder._id}
                    className="team-folder-item"
                    onClick={() => {
                      setSelectedFolder(folder);
                      onFolderSelect(folder._id);
                    }}
                  >
                    <div className="team-folder-icon"></div>
                    <div className="team-folder-info">
                      <div className="team-folder-header">
                        <div className="team-folder-name">{folder.name}</div>
                        {userRole && (
                          <span 
                            className="role-badge"
                            style={{ backgroundColor: getRoleBadgeColor(userRole) }}
                          >
                            {userRole === 'owner' ? ' Owner' : userRole.charAt(0).toUpperCase() + userRole.slice(1)}
                          </span>
                        )}
                      </div>
                      <div className="team-folder-meta">
                        <span className="meta-item">
                           {folder.members.length} member{folder.members.length !== 1 ? 's' : ''}
                        </span>
                        {stats && (
                          <>
                            <span className="meta-item">
                               {stats.fileCount} item{stats.fileCount !== 1 ? 's' : ''}
                            </span>
                            <span className="meta-item">
                               {formatFileSize(stats.totalSize)}
                            </span>
                          </>
                        )}
                        <span className="meta-item">
                           {new Date(folder.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="team-folder-members-preview">
                        {folder.members.slice(0, 5).map((member, idx) => (
                          <div
                            key={member.user._id}
                            className="member-avatar"
                            title={`${member.user.name} (${member.role})`}
                            style={{ backgroundColor: getRoleBadgeColor(member.role) }}
                          >
                            {getUserInitials(member.user.name)}
                          </div>
                        ))}
                        {folder.members.length > 5 && (
                          <div className="member-avatar more-members">
                            +{folder.members.length - 5}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="team-folder-actions">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setChatFolderId(folder._id);
                          setChatFolderName(folder.name);
                          setShowChat(true);
                        }}
                        className="chat-btn"
                        title="Open chat"
                      >
                         Chat
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedFolder(folder);
                          setShowAddMember(true);
                        }}
                        className="add-member-btn"
                      >
                        {canManageMembers(folder) ? 'Manage members' : 'Members'}
                      </button>
                      <div className="folder-menu-wrapper">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowFolderMenu(showFolderMenu === folder._id ? null : folder._id);
                          }}
                          className="folder-menu-btn"
                        >
                          ⋮
                        </button>
                        {showFolderMenu === folder._id && (
                          <div className="folder-menu" onClick={(e) => e.stopPropagation()}>
                            {isFolderOwner && (
                              <>
                                <button
                                  onClick={() => {
                                    setSelectedFolder(folder);
                                    setRenameValue(folder.name);
                                    setShowRenameModal(true);
                                    setShowFolderMenu(null);
                                  }}
                                  className="menu-item"
                                >
                                  Rename
                                </button>
                                <button
                                  onClick={() => {
                                    handleDeleteFolder(folder._id);
                                    setShowFolderMenu(null);
                                  }}
                                  className="menu-item delete"
                                >
                                  Delete Team Space…
                                </button>
                              </>
                            )}
                            {!isFolderOwner && (
                              <button
                                onClick={() => {
                                  handleLeaveFolder(folder._id);
                                  setShowFolderMenu(null);
                                }}
                                className="menu-item delete"
                              >
                                🚪 Leave Folder
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {showCreateModal && (
          <div className="modal-overlay-inner" onClick={() => setShowCreateModal(false)}>
            <div className="modal-content-small" onClick={(e) => e.stopPropagation()}>
              <h3>New Team Space</h3>
              <form onSubmit={handleCreateFolder}>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Folder Name"
                  className="form-input"
                  autoFocus
                />
                <div className="modal-actions">
                  <button type="button" onClick={() => setShowCreateModal(false)} className="cancel-button">
                    Cancel
                  </button>
                  <button type="submit" className="action-button">Create</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showAddMember && selectedFolder && (
          <div className="modal-overlay-inner" onClick={() => setShowAddMember(false)}>
            <div className="modal-content-small" onClick={(e) => e.stopPropagation()}>
              <h3>Members of {selectedFolder.name}</h3>
              {canManageMembers(selectedFolder) && (
                <form className="team-add-member" onSubmit={handleAddMember}>
                  <input
                    type="email"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Email address"
                    aria-label="Email address of the person to add"
                    className="form-input"
                    autoFocus
                  />
                  <select value={newMemberRole} onChange={(e) => setNewMemberRole(e.target.value as any)} className="role-select" aria-label="Role">
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button type="submit" className="action-button" disabled={!searchQuery.trim()}>Add</button>
                </form>
              )}
              {memberError && <p className="team-member-error" role="alert">{memberError}</p>}
              <p className="team-role-help">Viewers can open and download files. Editors can also upload and add folders. Admins can manage members.</p>
              <div className="current-members">
                <h4>Current Members ({selectedFolder.members.length})</h4>
                {selectedFolder.members.map((member) => {
                  const isMemberOwner = selectedFolder.owner.email === member.user.email;
                  const canManage = canManageMembers(selectedFolder);
                  
                  return (
                    <div key={member.user._id} className="member-item">
                      <div className="member-info">
                        <div 
                          className="member-avatar-large"
                          style={{ backgroundColor: getRoleBadgeColor(member.role) }}
                        >
                          {getUserInitials(member.user.name)}
                        </div>
                        <div className="member-details">
                          <div className="member-name">
                            {member.user.name}
                            {isMemberOwner && <span className="owner-badge"> Owner</span>}
                          </div>
                          <div className="member-email">{member.user.email}</div>
                          {canManage && !isMemberOwner && (
                            <select
                              value={member.role}
                              onChange={(e) => handleChangeRole(member.user._id, e.target.value as any)}
                              className="role-select-inline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="viewer">Viewer</option>
                              <option value="editor">Editor</option>
                              <option value="admin">Admin</option>
                            </select>
                          )}
                          {!canManage && (
                            <span 
                              className="role-badge-inline"
                              style={{ backgroundColor: getRoleBadgeColor(member.role) }}
                            >
                              {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                            </span>
                          )}
                        </div>
                      </div>
                      {canManage && !isMemberOwner && (
                        <button
                          onClick={() => handleRemoveMember(member.user._id)}
                          className="remove-member-btn"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <button onClick={() => setShowAddMember(false)} className="action-button">
                Done
              </button>
            </div>
          </div>
        )}

        {showRenameModal && selectedFolder && (
          <div className="modal-overlay-inner" onClick={() => setShowRenameModal(false)}>
            <div className="modal-content-small" onClick={(e) => e.stopPropagation()}>
              <h3>Rename Team Space</h3>
              <form onSubmit={(e) => { e.preventDefault(); handleRenameFolder(); }}>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="New folder name"
                  className="form-input"
                  autoFocus
                />
                <div className="modal-actions">
                  <button type="button" onClick={() => setShowRenameModal(false)} className="cancel-button">
                    Cancel
                  </button>
                  <button type="submit" className="action-button">Rename</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showChat && chatFolderId && (
          <div className="chat-modal-overlay" onClick={() => setShowChat(false)}>
            <div className="chat-modal-content" onClick={(e) => e.stopPropagation()}>
              <TeamFolderChat
                teamFolderId={chatFolderId}
                teamFolderName={chatFolderName}
                onClose={() => setShowChat(false)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TeamFolders;










