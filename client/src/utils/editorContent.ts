export const normalizeEditorHtml = (html: string) =>
  html
    .replace(/<p><br><\/p>/gi, '<p></p>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const textToEditorHtml = (text: string) => {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`);

  return paragraphs.length > 0 ? paragraphs.join('') : '<p></p>';
};

export const editorHtmlToPlainText = (html: string) => {
  if (typeof window === 'undefined') {
    return html;
  }

  const container = document.createElement('div');
  container.innerHTML = html;

  const blockNodes = Array.from(container.childNodes);

  if (blockNodes.length === 0) {
    return container.textContent || '';
  }

  const parts = blockNodes
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent || '';
      }

      const element = node as HTMLElement;
      return element.innerText || element.textContent || '';
    })
    .map((part) => part.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd());

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

export const countWords = (text: string) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};
