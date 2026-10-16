import React from 'react';
import { useAuth } from '../context/AuthContext';
import { workspacePages } from '../config/workspaceNavigation';
import { formatBytes } from '../utils/fileDisplay';
import { ChevronRightIcon } from './Icons';
import './OverviewPages.css';

interface SettingsViewProps {
  onOpenPage: (pageId: string) => void;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  'secured-links': 'Password-protected links that expire.',
  relationships: 'Link related files together.',
  templates: 'Reusable starting points for new files.',
  shortcuts: 'Save websites alongside your files.',
  analytics: 'Where your storage goes and how files are used.',
  security: 'Audit log, classification and access settings.',
  integrations: 'Connect File Box to other apps.',
};

const SettingsView: React.FC<SettingsViewProps> = ({ onOpenPage }) => {
  const { user, isLocalPreview } = useAuth();
  const tools = workspacePages.filter(page => page.secondary);
  const storagePercent = user?.storageLimit ? Math.min(100, (user.storageUsed / user.storageLimit) * 100) : 0;

  return (
    <div className="overview-page settings-view">
      <header className="overview-header">
        <h1>Settings</h1>
        <p>Your account, storage and additional File Box tools.</p>
      </header>

      <section className="overview-section">
        <div className="overview-section-head"><h2>Account</h2></div>
        <dl className="settings-account">
          <div><dt>Name</dt><dd>{user?.name}</dd></div>
          <div><dt>Email</dt><dd>{isLocalPreview ? 'Local workspace (sign-in disabled during development)' : user?.email}</dd></div>
          <div>
            <dt>Storage</dt>
            <dd>
              {formatBytes(user?.storageUsed || 0)} of {formatBytes(user?.storageLimit || 0)} used
              <span className="settings-storage-bar"><span style={{ width: `${storagePercent}%` }} /></span>
            </dd>
          </div>
          <div><dt>File Box AI</dt><dd>Runs locally with Ollama. Your files are never sent to a hosted AI service.</dd></div>
        </dl>
      </section>

      <section className="overview-section">
        <div className="overview-section-head"><h2>More tools</h2></div>
        <ul className="settings-tools">
          {tools.map(tool => (
            <li key={tool.id}>
              <button onClick={() => onOpenPage(tool.id)}>
                <span><strong>{tool.label}</strong><small>{TOOL_DESCRIPTIONS[tool.id]}</small></span>
                <ChevronRightIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};

export default SettingsView;
