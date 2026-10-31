import React, { useEffect, useState } from 'react';
import { filesAPI } from '../services/api';
import { ImageCaption as Caption } from '../types';
import { AIAssistantIcon } from './Icons';
import './ImageCaption.css';

interface ImageCaptionProps {
  fileId: string;
  initial?: Caption;
  canWrite: boolean;
}

const POLL_MS = 4000;
const GIVE_UP_MS = 5 * 60 * 1000;

/** A picture's fun caption from File Box AI, under its card; shows progress while it is being written. */
const ImageCaption: React.FC<ImageCaptionProps> = ({ fileId, initial, canWrite }) => {
  const [caption, setCaption] = useState<Caption | undefined>(initial);
  const [error, setError] = useState('');

  useEffect(() => { setCaption(initial); }, [initial]);

  // Freshly uploaded pictures may not show the caption status yet; check once, then keep checking while it is written.
  const writing = caption?.status === 'writing' || !caption?.status;
  useEffect(() => {
    if (!writing) return;
    let stopped = false;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const data = await filesAPI.getCaption(fileId);
        if (stopped) return;
        setCaption(data.caption || { status: 'failed' });
        if (data.caption?.status !== 'writing' && data.caption?.status) return;
        if (!data.caption?.status && Date.now() - started > 15000) return; // nothing was started
      } catch {
        return;
      }
      if (!stopped && Date.now() - started < GIVE_UP_MS) timer = setTimeout(check, POLL_MS);
    };
    timer = setTimeout(check, caption?.status === 'writing' ? POLL_MS : 1500);
    return () => { stopped = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, writing]);

  const askForCaption = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setError('');
    try {
      const data = await filesAPI.newCaption(fileId);
      setCaption(data.caption);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not ask for a caption.');
    }
  };

  const status = caption?.status;
  if (status === 'writing') {
    return <p className="image-caption writing" role="status"><AIAssistantIcon size={13} /> Writing a caption…</p>;
  }
  if (status === 'done' && caption?.text) {
    return (
      <div className="image-caption" title={caption.text}>
        <p className="image-caption-text">{caption.text}</p>
        <div className="image-caption-row">
          {caption.hashtags && caption.hashtags.length > 0 && (
            <p className="image-caption-tags">{caption.hashtags.map(tag => `#${tag}`).join(' ')}</p>
          )}
          {canWrite && (
            <button className="image-caption-icon" onClick={askForCaption} title="New caption" aria-label="Write a new caption">
              <AIAssistantIcon size={13} />
            </button>
          )}
        </div>
        {error && <p className="image-caption-error" role="alert">{error}</p>}
      </div>
    );
  }
  if (!canWrite) return null;
  return (
    <div className="image-caption">
      {status === 'failed' && <p className="image-caption-error">{caption?.error || 'No caption yet.'}</p>}
      <button className="image-caption-again" onClick={askForCaption}>
        <AIAssistantIcon size={12} /> {status === 'failed' ? 'Try again' : 'Write a fun caption'}
      </button>
      {error && <p className="image-caption-error" role="alert">{error}</p>}
    </div>
  );
};

export default ImageCaption;
