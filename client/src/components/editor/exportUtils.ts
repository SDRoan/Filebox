import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

const sanitizeFileName = (value: string) =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '') || 'document';

const triggerDownload = (blob: Blob, fileName: string) => {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(anchor);
};

export const downloadHtmlDocument = (title: string, html: string) => {
  const safeTitle = sanitizeFileName(title);
  const content = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        background: #f1f3f4;
        color: #1f2937;
        font-family: Arial, Helvetica, sans-serif;
      }
      main {
        width: min(816px, calc(100vw - 32px));
        margin: 32px auto;
        background: #ffffff;
        box-shadow: 0 16px 48px rgba(15, 23, 42, 0.12);
        border-radius: 12px;
        padding: 96px 88px 120px;
        box-sizing: border-box;
      }
      img {
        max-width: 100%;
        border-radius: 12px;
      }
      blockquote {
        margin: 1.25rem 0;
        padding-left: 1rem;
        border-left: 3px solid #cbd5e1;
        color: #475569;
      }
      ul[data-type="taskList"] {
        list-style: none;
        padding-left: 0;
      }
      ul[data-type="taskList"] li {
        display: flex;
        gap: 0.75rem;
        align-items: flex-start;
      }
    </style>
  </head>
  <body>
    <main>${html}</main>
  </body>
</html>`;

  triggerDownload(new Blob([content], { type: 'text/html;charset=utf-8' }), `${safeTitle}.html`);
};

export const downloadPdfFromElement = async (title: string, element: HTMLElement) => {
  const safeTitle = sanitizeFileName(title);

  const canvas = await html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  });

  const imageData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'letter',
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imageWidth = pageWidth;
  const imageHeight = (canvas.height * imageWidth) / canvas.width;

  let remainingHeight = imageHeight;
  let offsetY = 0;

  pdf.addImage(imageData, 'PNG', 0, offsetY, imageWidth, imageHeight, undefined, 'FAST');
  remainingHeight -= pageHeight;

  while (remainingHeight > 0) {
    offsetY = remainingHeight - imageHeight;
    pdf.addPage();
    pdf.addImage(imageData, 'PNG', 0, offsetY, imageWidth, imageHeight, undefined, 'FAST');
    remainingHeight -= pageHeight;
  }

  pdf.save(`${safeTitle}.pdf`);
};

export const formatTimestamp = (value: Date | null) => {
  if (!value) {
    return 'Ready';
  }

  return value.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
};

export const getLocalDraftKey = (fileId: string) => `filebox-doc-editor:${fileId}`;
