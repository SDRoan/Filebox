import React from 'react';
import './ConnectionsError.css';

export function connectionErrorMessage(error: any): string {
  if (!error?.response) return 'The workspace server is unavailable. Your connections have not been changed. Try again once the server is back online.';
  if (error.response.status === 401) return 'Your session has expired. Refresh the page to reconnect to your workspace.';
  return 'Connections could not be loaded. Please try again.';
}

const ConnectionsError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="connections-error" role="alert">
    <h3>Couldn’t load connections</h3>
    <p>{message}</p>
    <button type="button" onClick={onRetry}>Try again</button>
  </div>
);

export default ConnectionsError;
