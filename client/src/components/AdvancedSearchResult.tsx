import React, { useRef, useState } from 'react';
import ItemActions from './ItemActions';
import ShareDialog from './ShareDialog';
import MoveCopyModal from './MoveCopyModal';
import ChangeCategoryDialog from './ChangeCategoryDialog';
import { DocumentIcon, ImageIcon, VideoIcon, AudioIcon, StarredIcon } from './Icons';
import { advancedSearchAPI, filesAPI, AdvancedSearchResult as Result, FileClassification } from '../services/api';
import { capabilitiesFor } from '../utils/permissions';
import { fileKind, formatRelativeTime } from '../utils/fileDisplay';

const FORMAT_LABEL: Record<Result['technicalType'], string> = { pdf: 'PDF', image: 'Image', document: 'Document', text: 'Text', code: 'Code', other: 'Other' };
const REASON_LABEL: Record<Result['matchedIn'][number], string> = { content: 'in text', name: 'in name', type: 'document type', category: 'category', topic: 'topic', meaning: 'by meaning' };
const MAX_TOPICS = 3;

/**
 * The snippet exactly as the server sent it, as plain text, with the server's highlight ranges in <mark>.
 * File text is never treated as HTML.
 */
export const SnippetText: React.FC<{ text: string; highlights: Array<[number, number]> }> = ({ text, highlights }) => {
  const ranges = highlights
    .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= text.length)
    .sort((x, y) => x[0] - y[0]);
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a < at) return; // overlapping range
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
};

const KindIcon: React.FC<{ result: Result }> = ({ result }) => {
  const kind = fileKind(result.mimeType, result.originalName);
  if (kind === 'Image') return <ImageIcon size={18} />;
  if (kind === 'Video') return <VideoIcon size={18} />;
  if (kind === 'Audio') return <AudioIcon size={18} />;
  return <DocumentIcon size={18} />;
};

const whereLabel = (result: Result) => {
  if (result.access.source === 'shared') return `Shared by ${result.ownerName || 'someone'}`;
  if (result.access.source === 'team') return `Team Space · ${result.access.teamName || result.folderName || 'Team'}`;
  return result.folderName || 'My Files';
};

const matchedLine = (result: Result) => {
  if (!result.matchedIn.length) return '';
  const words = result.matchedTerms.slice(0, 4).map(t => `“${t}”`).join(', ');
  const reasons = result.matchedIn.map(r => REASON_LABEL[r]).join(', ');
  return words ? `${words} · ${reasons}` : reasons;
};

interface AdvancedSearchResultProps {
  result: Result;
  taxonomy: Array<{ name: string; documentTypes: string[] }>;
  dateField: 'modified' | 'uploaded';
  activeTopic: string;
  onOpen: (result: Result) => void;
  onShowInFolder: (result: Result) => void;
  onTopic: (topic: string) => void;
  onChanged: (message: string) => void;
  onStarred: (id: string, starred: boolean) => void;
}

const AdvancedSearchResult: React.FC<AdvancedSearchResultProps> = ({ result, taxonomy, dateField, activeTopic, onOpen, onShowInFolder, onTopic, onChanged, onStarred }) => {
  const [dialog, setDialog] = useState<'' | 'share' | 'move' | 'category'>('');
  const cardRef = useRef<HTMLLIElement>(null);
  const caps = capabilitiesFor(result.access.role);
  const cls = result.classification;

  const closeDialog = () => {
    setDialog('');
    // Back to the menu button the dialog was opened from.
    setTimeout(() => cardRef.current?.querySelector<HTMLElement>('.adv-result-menu summary')?.focus(), 0);
  };

  const download = async () => {
    try {
      const blob = await filesAPI.downloadFile(result._id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.originalName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      onChanged(`Couldn't download ${result.originalName}.`);
    }
  };

  const toggleStar = async () => {
    try {
      await filesAPI.starFile(result._id);
      onStarred(result._id, !result.isStarred);
    } catch {
      onChanged(`Couldn't update the star on ${result.originalName}.`);
    }
  };

  const reclassify = async () => {
    try {
      const { profile } = await advancedSearchAPI.reclassify(result._id);
      onChanged(profile === 'queued' ? `Rechecking ${result.originalName}. Its category may update in a moment.` : `Rechecked ${result.originalName}.`);
    } catch (error: any) {
      onChanged(error?.response?.status === 403 ? 'Only the owner or an editor can recheck this file.' : `Couldn't recheck ${result.originalName}.`);
    }
  };

  const date = dateField === 'uploaded' ? result.createdAt : result.updatedAt;
  const topics = cls.topics || [];

  return (
    <li className="adv-result" ref={cardRef}>
      <div className="adv-result-main">
        <span className={`adv-result-icon kind-${fileKind(result.mimeType, result.originalName).toLowerCase()}`} aria-hidden="true"><KindIcon result={result} /></span>
        <div className="adv-result-body">
          <button type="button" className="adv-result-name" onClick={() => onOpen(result)}>{result.originalName}</button>
          <p className="adv-result-chips">
            <span className="adv-chip adv-chip-category">{cls.primaryCategory}</span>
            <span className="adv-chip">{cls.documentType}</span>
            <span className="adv-chip adv-chip-format">{FORMAT_LABEL[result.technicalType]}</span>
            {cls.source === 'user' && <span className="adv-chip-note" title="You set this category">Your label</span>}
          </p>
          {result.snippet && (
            <blockquote className={`adv-result-snippet ${result.technicalType === 'code' ? 'is-code' : ''}`} title={result.snippet.text}>
              <span className="adv-snippet-text"><SnippetText text={result.snippet.text} highlights={result.snippet.highlights} /></span>
              <cite>{result.snippet.source}</cite>
            </blockquote>
          )}
          {matchedLine(result) && <p className="adv-result-matched"><span>Matched</span> {matchedLine(result)}</p>}
          <p className="adv-result-meta">
            {whereLabel(result)} · {dateField === 'uploaded' ? 'Uploaded' : 'Modified'} {formatRelativeTime(date)}
          </p>
          {topics.length > 0 && (
            <p className="adv-result-topics" aria-label="Topics">
              {topics.slice(0, MAX_TOPICS).map(topic => (
                <button type="button" key={topic} className={`adv-topic ${topic.toLowerCase() === activeTopic.toLowerCase() ? 'is-active' : ''}`}
                  onClick={() => onTopic(topic)} aria-pressed={topic.toLowerCase() === activeTopic.toLowerCase()}>
                  {topic}
                </button>
              ))}
              {topics.length > MAX_TOPICS && <span className="adv-topic-more">+{topics.length - MAX_TOPICS}</span>}
            </p>
          )}
        </div>
        <div className="adv-result-actions">
          {caps.canStar && (
            <button type="button" className={`adv-star ${result.isStarred ? 'is-starred' : ''}`} onClick={toggleStar}
              aria-pressed={result.isStarred} aria-label={result.isStarred ? `Unstar ${result.originalName}` : `Star ${result.originalName}`}>
              <StarredIcon size={18} color="currentColor" />
            </button>
          )}
          <ItemActions className="adv-result-menu" label={`Actions for ${result.originalName}`}>
            <button type="button" onClick={() => onOpen(result)}>Open</button>
            {caps.canDownload && <button type="button" onClick={download}>Download</button>}
            <button type="button" onClick={() => onShowInFolder(result)}>Show in folder</button>
            {caps.canShare && <button type="button" onClick={() => setDialog('share')}>Share</button>}
            {caps.canMove && <button type="button" onClick={() => setDialog('move')}>Move</button>}
            {cls.canChange && <button type="button" onClick={() => setDialog('category')}>Change category</button>}
            {cls.canChange && <button type="button" onClick={reclassify}>Recheck category</button>}
          </ItemActions>
        </div>
      </div>
      {dialog === 'share' && <ShareDialog fileId={result._id} fileName={result.originalName} onClose={closeDialog} />}
      {dialog === 'move' && (
        <MoveCopyModal itemId={result._id} itemName={result.originalName} itemType="file" operation="move" onClose={closeDialog}
          onSuccess={() => { closeDialog(); onChanged(`Moved ${result.originalName}.`); }} />
      )}
      {dialog === 'category' && (
        <ChangeCategoryDialog fileId={result._id} fileName={result.originalName} current={cls} taxonomy={taxonomy} onClose={closeDialog}
          onSaved={(next: FileClassification) => { closeDialog(); onChanged(`Category updated: ${next.primaryCategory} · ${next.documentType}.`); }} />
      )}
    </li>
  );
};

export default AdvancedSearchResult;
