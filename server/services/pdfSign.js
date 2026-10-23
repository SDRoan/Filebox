const fs = require('fs-extra');
const { PDFDocument } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');

/**
 * Signing PDFs: page images for placing a signature, and stamping a saved signature onto a page.
 * Positions are fractions of the page (0..1 from the top-left), so they do not depend on how large
 * the page was shown on screen.
 */

const MAX_PAGES = 200;

// Protected (encrypted) PDFs cannot be changed without breaking them: pdf-lib can read past the
// protection but writes a file that viewers refuse to open. They are left as they are.
const PROTECTED_MESSAGE = 'This PDF is protected (encrypted), so File Box cannot add a signature without breaking it. '
  + 'Ask the sender for an unprotected copy, or print it to a new PDF first.';
const protectedError = () => Object.assign(new Error(PROTECTED_MESSAGE), { status: 409, code: 'PDF_PROTECTED' });

/** Page count and sizes (in PDF points). */
async function pageInfo(pdfPath) {
  const doc = await PDFDocument.load(await fs.readFile(pdfPath), { ignoreEncryption: true });
  const pages = doc.getPages().slice(0, MAX_PAGES).map((page) => {
    const { width, height } = page.getSize();
    return { width, height };
  });
  return { total: doc.getPageCount(), pages, protected: doc.isEncrypted, protectedMessage: doc.isEncrypted ? PROTECTED_MESSAGE : undefined };
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
  if (doc.isEncrypted) throw protectedError();
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

/** Check that a PDF opens and its pages can be read (used before a signed copy replaces the original). */
async function verifyPdf(bytes) {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    await parser.getText();
    await parser.getScreenshot({ first: 1, scale: 0.3 });
  } catch (error) {
    throw Object.assign(new Error('Signing produced a file that would not open, so nothing was changed.'), { status: 422, cause: error });
  } finally {
    await parser.destroy();
  }
}

module.exports = { pageInfo, pageImage, stampSignature, verifyPdf };
