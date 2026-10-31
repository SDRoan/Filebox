import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import './PdfPageViewer.css';

// pdf.js does its parsing in a worker, bundled with the app so it always matches the library version.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

interface PdfPageViewerProps {
  url: string;
  name: string;
  // The page most in view, and how many there are (Ask File Box uses this for "this page").
  onPageChange?: (page: number, total: number) => void;
  onOpenBrowserViewer?: () => void;
}

/**
 * PDF preview drawn with pdf.js: pages are rendered only as they scroll into view, the page most in view
 * is tracked (and reported), and there are previous/next controls with "Page N of M".
 */
const PdfPageViewer: React.FC<PdfPageViewerProps> = ({ url, name, onPageChange, onOpenBrowserViewer }) => {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(1.294); // page height / width, from page 1 (A4 until known)
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rendered = useRef(new Set<number>());
  const visibility = useRef(new Map<number, number>());

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url });
    task.promise
      .then(async (loaded) => {
        if (cancelled) return;
        const first = await loaded.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        setRatio(viewport.height / viewport.width);
        setDoc(loaded);
      })
      .catch(() => { if (!cancelled) setError('This PDF could not be shown here.'); });
    return () => { cancelled = true; task.destroy(); };
  }, [url]);

  // Fit pages to the width of the preview.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.max(200, Math.min(el.clientWidth - 32, 1100)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  // A new width means pages are drawn again at the new size.
  useEffect(() => { rendered.current.clear(); }, [width]);

  const renderPage = useCallback(async (n: number) => {
    if (!doc || !width || rendered.current.has(n)) return;
    const holder = pageRefs.current[n - 1];
    if (!holder) return;
    rendered.current.add(n);
    try {
      const pdfPage = await doc.getPage(n);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await pdfPage.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      holder.replaceChildren(canvas);
    } catch {
      rendered.current.delete(n);
    }
  }, [doc, width]);

  // Lazy rendering and page tracking: pages near the view are drawn; the most visible one is "this page".
  useEffect(() => {
    const root = scrollRef.current;
    if (!doc || !root || !width) return undefined;
    const near = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) renderPage(Number((entry.target as HTMLElement).dataset.page)); });
    }, { root, rootMargin: '600px 0px' });
    const seen = new IntersectionObserver(entries => {
      entries.forEach(entry => visibility.current.set(Number((entry.target as HTMLElement).dataset.page), entry.intersectionRatio));
      const [best] = Array.from(visibility.current.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (best && best[1] > 0) setPage(best[0]);
    }, { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    pageRefs.current.forEach(el => { if (el) { near.observe(el); seen.observe(el); } });
    return () => { near.disconnect(); seen.disconnect(); };
  }, [doc, width, renderPage]);

  useEffect(() => { if (doc) onPageChange?.(page, doc.numPages); }, [page, doc, onPageChange]);

  const goTo = (n: number) => {
    if (!doc) return;
    const target = Math.min(doc.numPages, Math.max(1, n));
    pageRefs.current[target - 1]?.scrollIntoView({ block: 'start' });
    setPage(target);
  };

  if (error) {
    return (
      <div className="pdf-viewer-error">
        <p>{error}</p>
        {onOpenBrowserViewer && <button className="btn-secondary" onClick={onOpenBrowserViewer}>Open in browser viewer</button>}
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-bar" role="toolbar" aria-label={`Pages of ${name}`}>
        <button onClick={() => goTo(page - 1)} disabled={!doc || page <= 1} aria-label="Previous page">‹</button>
        <span className="pdf-viewer-page" aria-live="polite">{doc ? `Page ${page} of ${doc.numPages}` : 'Loading…'}</span>
        <button onClick={() => goTo(page + 1)} disabled={!doc || page >= (doc?.numPages || 1)} aria-label="Next page">›</button>
        {onOpenBrowserViewer && <button className="pdf-viewer-browser" onClick={onOpenBrowserViewer}>Open in browser viewer</button>}
      </div>
      <div className="pdf-viewer-scroll" ref={scrollRef} data-pdf-viewer>
        {doc && Array.from({ length: doc.numPages }, (_, i) => (
          <div
            key={i}
            ref={el => { pageRefs.current[i] = el; }}
            className="pdf-viewer-page-holder"
            data-page={i + 1}
            aria-label={`Page ${i + 1}`}
            style={{ width: width || undefined, height: width ? Math.floor(width * ratio) : undefined }}
          />
        ))}
      </div>
    </div>
  );
};

export default PdfPageViewer;
