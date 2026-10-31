import React from 'react';
import { FileItem } from '../types';
import { fileKind, formatBytes, formatRelativeTime, interactionLabel } from '../utils/fileDisplay';
import { DocumentIcon, ImageIcon, VideoIcon, AudioIcon } from './Icons';
import ItemActions from './ItemActions';

export type FileRowItem = FileItem & {
  lastInteractionAt?: string;
  lastInteraction?: string;
  sharePermission?: string;
};

interface FileRowListProps {
  files: FileRowItem[];
  onOpen: (file: FileRowItem) => void;
  // 'activity' shows what the user last did; 'owner' shows who shared it.
  detail?: 'activity' | 'owner';
  // Optional: an actions menu for each row (Recent uses it for "Add to board…").
  onAddToBoard?: (file: FileRowItem) => void;
}

const KindIcon: React.FC<{ kind: string }> = ({ kind }) => {
  if (kind === 'Image') return <ImageIcon size={16} />;
  if (kind === 'Video') return <VideoIcon size={16} />;
  if (kind === 'Audio') return <AudioIcon size={16} />;
  return <DocumentIcon size={16} />;
};

const ownerName = (file: FileRowItem) => (typeof file.owner === 'object' && file.owner ? file.owner.name : '');

const FileRowList: React.FC<FileRowListProps> = ({ files, onOpen, detail = 'activity', onAddToBoard }) => (
  <ul className="file-row-list">
    {files.map(file => {
      const kind = fileKind(file.mimeType, file.originalName);
      return (
        <li key={file._id} className={onAddToBoard ? 'has-actions' : undefined}>
          <button className="file-row" onClick={() => onOpen(file)}>
            <span className={`file-row-icon kind-${kind.toLowerCase()}`} aria-hidden="true"><KindIcon kind={kind} /></span>
            <span className="file-row-name">{file.originalName}</span>
            <span className="file-row-detail">
              {detail === 'owner'
                ? `Shared by ${ownerName(file) || 'someone'}`
                : `${interactionLabel(file.lastInteraction)} · ${formatRelativeTime(file.lastInteractionAt || file.updatedAt)}`}
            </span>
            <span className="file-row-meta">{kind} · {formatBytes(file.size)}</span>
          </button>
          {onAddToBoard && (
            <ItemActions className="file-row-menu" label={`Actions for ${file.originalName}`}>
              <button type="button" onClick={() => onAddToBoard(file)}>Add to board…</button>
            </ItemActions>
          )}
        </li>
      );
    })}
  </ul>
);

export default FileRowList;
