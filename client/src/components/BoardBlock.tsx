import React from 'react';
import ItemActions from './ItemActions';
import { DocumentIcon, ImageIcon, VideoIcon, AudioIcon, FolderIcon, StarredIcon } from './Icons';
import { BoardBlock as AnyBlock } from '../services/api';
import { fileKind, formatRelativeTime } from '../utils/fileDisplay';

type Block = Extract<AnyBlock, { type: 'file' | 'folder' }>;

const FORMAT_LABEL: Record<string, string> = { pdf: 'PDF', image: 'Image', document: 'Document', text: 'Text', code: 'Code', other: 'File' };

/** What a block is called (for menus and screen readers). An unavailable item has no name. */
export const blockLabel = (block: Block) => (block.ref.available ? block.ref.name : block.type === 'file' ? 'Unavailable file' : 'Unavailable folder');

const whereLabel = (ref: Extract<Block['ref'], { available: true }>) => {
  if (ref.source === 'shared') return `Shared by ${ref.ownerName || 'someone'}`;
  if (ref.source === 'team') return `Team Space${ref.teamName ? ` · ${ref.teamName}` : ''}`;
  return 'Yours';
};

interface BoardBlockProps {
  block: Block;
  pending?: boolean;
  phone: boolean;
  first: boolean;
  last: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}

/**
 * One file or folder on a board: only what is needed to recognise it (name, kind, category, where it is,
 * when it changed). Nothing is read from the file itself. Removing it only takes it off the board.
 */
const BoardBlock: React.FC<BoardBlockProps> = ({ block, pending = false, phone, first, last, onOpen, onRemove, onMove }) => {
  const ref = block.ref;
  const menu = (
    <ItemActions className="board-block-menu" label={`Options for ${blockLabel(block)}`}>
      {ref.available && <button type="button" onClick={onOpen}>Open</button>}
      {phone && !first && <button type="button" onClick={() => onMove(-1)}>Move up</button>}
      {phone && !last && <button type="button" onClick={() => onMove(1)}>Move down</button>}
      <button type="button" onClick={onRemove}>Remove from board</button>
    </ItemActions>
  );

  if (!ref.available) {
    return (
      <div className="board-block-card is-unavailable">
        <div className="board-block-top">
          <span className="board-block-icon" aria-hidden="true">{block.type === 'folder' ? <FolderIcon size={18} /> : <DocumentIcon size={18} />}</span>
          <p className="board-block-name">{block.type === 'file' ? 'File no longer available' : 'Folder no longer available'}</p>
          {menu}
        </div>
        <button type="button" className="board-block-remove" onClick={onRemove}>Remove from board</button>
      </div>
    );
  }

  if (block.type === 'folder') {
    return (
      <div className={`board-block-card is-folder ${pending ? 'is-pending' : ''}`}>
        <div className="board-block-top">
          <span className="board-block-icon is-folder" aria-hidden="true"><FolderIcon size={18} /></span>
          <p className="board-block-name" title={ref.name}>{ref.name}</p>
          {menu}
        </div>
        <p className="board-block-meta">
          {pending ? 'Adding…' : ref.itemCount === undefined ? 'Folder' : ref.itemCount === 0 ? 'Empty' : `${ref.itemCount} ${ref.itemCount === 1 ? 'item' : 'items'}`}
          {' · '}{whereLabel(ref)}
        </p>
      </div>
    );
  }

  const kind = fileKind(ref.mimeType || '', ref.name);
  const Icon = kind === 'Image' ? ImageIcon : kind === 'Video' ? VideoIcon : kind === 'Audio' ? AudioIcon : DocumentIcon;
  const showClass = ref.category && ref.documentType && !(ref.category === 'Other' && ref.documentType === 'Unknown');
  return (
    <div className={`board-block-card ${pending ? 'is-pending' : ''}`}>
      <div className="board-block-top">
        <span className={`board-block-icon kind-${kind.toLowerCase()}`} aria-hidden="true"><Icon size={18} /></span>
        <p className="board-block-name" title={ref.name}>{ref.name}</p>
        {ref.isStarred && <span className="board-block-star" title="Starred"><StarredIcon size={14} color="currentColor" /><span className="boards-visually-hidden">Starred</span></span>}
        {menu}
      </div>
      <p className="board-block-chips">
        {showClass && <span className="board-chip">{ref.category} · {ref.documentType}</span>}
        <span className="board-chip is-format">{FORMAT_LABEL[ref.technicalType || 'other']}</span>
      </p>
      <p className="board-block-meta">
        {pending ? 'Adding…' : `${whereLabel(ref)}${ref.updatedAt ? ` · Modified ${formatRelativeTime(ref.updatedAt)}` : ''}`}
      </p>
    </div>
  );
};

export default BoardBlock;
