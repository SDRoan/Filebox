const fs = require('fs-extra');
const { PDFDocument } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');

/**
 * Signing PDFs: page images for placing a signature, and stamping a saved signature onto a page.
 * Positions are fractions of the page (0..1 from the top-left), so they do not depend on how large
 * the page was shown on screen.
 */

const MAX_PAGES = 200;

/** Page count and sizes (in PDF points). */
async function pageInfo(pdfPath) {
  const doc = await PDFDocument.load(await fs.readFile(pdfPath), { ignoreEncryption: true });
  const pages = doc.getPages().slice(0, MAX_PAGES).map((page) => {
    const { width, height } = page.getSize();
    return { width, height };
  });
  return { total: doc.getPageCount(), pages };
}

/** One page as a PNG (for showing it while placing the signature). */
async function pageImage(pdfPath, pageNumber, scale = 1.5) {
  const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(pdfPath)) });
  try {
    const result = await parser.getScreenshot({ partial: [pageNumber], scale, imageBuffer: true });
    const page = (result.pages || [])[0];
    if (!page) throw Object.assign(new Error('That page does not exist.'), { status: 404 });
    return Buffer.from(page.data);
  } finally {
    await parser.destroy();
  }
}

/** Decode a signature saved by the signature pad (a data URL or bare base64 PNG/JPEG). */
function signatureImage(signatureData = '') {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(signatureData);
  const kind = match ? match[1].toLowerCase() : 'png';
  const bytes = Buffer.from(match ? match[2] : signatureData, 'base64');
  if (!bytes.length) throw Object.assign(new Error('This signature has no image.'), { status: 400 });
  return { kind: kind === 'png' ? 'png' : 'jpg', bytes };
}

/**
 * Stamp a signature onto a page. `place` = { page (1-based), x, y, width } where x/y are the
 * signature's top-left corner and width its width, all as fractions of the page.
 * Returns { bytes, height } (the new PDF and the signature's height as a fraction of the page).
 */
async function stampSignature(pdfPath, signatureData, place) {
  const doc = await PDFDocument.load(await fs.readFile(pdfPath), { ignoreEncryption: true });
  const page = doc.getPages()[place.page - 1];
  if (!page) throw Object.assign(new Error('That page does not exist.'), { status: 400 });
  const { kind, bytes } = signatureImage(signatureData);
  const image = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const width = place.width * pageWidth;
  const height = width * (image.height / image.width);
  page.drawImage(image, {
    x: place.x * pageWidth,
    y: pageHeight - place.y * pageHeight - height, // PDF coordinates start at the bottom-left
    width,
    height,
  });
  return { bytes: await doc.save(), height: height / pageHeight };
}

module.exports = { pageInfo, pageImage, stampSignature };
