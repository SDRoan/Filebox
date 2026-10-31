import React, { useEffect, useRef, useState } from 'react';
import { filesAPI } from '../services/api';
import './ImageThumbnail.css';

interface ImageThumbnailProps {
  fileId: string;
  name: string;
  fallback: React.ReactNode;
}

/** The picture itself on an image's file card, loaded once the card scrolls into view. */
const ImageThumbnail: React.FC<ImageThumbnailProps> = ({ fileId, name, fallback }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let objectUrl = '';
    let cancelled = false;
    setFailed(false);
    filesAPI.getThumbnail(fileId)
      .then(blob => { objectUrl = URL.createObjectURL(blob); if (cancelled) URL.revokeObjectURL(objectUrl); else setUrl(objectUrl); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [visible, fileId]);

  return (
    <div ref={boxRef} className={`image-thumbnail${url ? ' loaded' : ''}`}>
      {url && !failed ? <img src={url} alt={name} draggable={false} onError={() => setFailed(true)} /> : fallback}
    </div>
  );
};

export default ImageThumbnail;
