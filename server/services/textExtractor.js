const fs = require('fs-extra');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const Tesseract = require('tesseract.js');

// OCR language data ships with the repo (server/eng.traineddata), so OCR works offline from any working directory.
const OCR_OPTIONS = { cachePath: path.join(__dirname, '..'), langPath: path.join(__dirname, '..'), gzip: false };

/**
 * Run OCR in a dedicated worker. Without an errorHandler, tesseract.js throws worker errors
 * outside any try/catch (e.g. for a corrupt or mislabeled image), which crashes the server.
 */
async function ocrImage(input, label = 'OCR') {
  let workerError = null;
  const worker = await Tesseract.createWorker(config.extraction.ocrLanguage, 1, {
    ...OCR_OPTIONS,
    errorHandler: (error) => { workerError = error; },
    logger: (message) => {
      if (message.status === 'recognizing text') console.log(`[${label}] ${Math.round(message.progress * 100)}%`);
    },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '3' }); // automatic layout, no orientation data needed
    const result = await worker.recognize(input);
    return (result.data?.text || '').trim();
  } catch (error) {
    throw new Error(String(workerError || error?.message || error));
  } finally {
    await worker.terminate().catch(() => {});
  }
}
const mammoth = require('mammoth');
const config = require('../config/aiConfig');
const ollamaClient = require('./ollamaClient');

let pdfjsLib = null;
let createCanvas = null;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const canvasModule = require('canvas');
  createCanvas = canvasModule.createCanvas;
  console.log('[PDF Extract] OCR rendering support enabled for scanned PDFs');
} catch (error) {
  console.log('[PDF Extract] OCR rendering support disabled (canvas/pdfjs not available)');
}

class TextExtractor {
  getFileInfo(mimeType = '', fileName = '') {
    const normalizedMimeType = (mimeType || '').toLowerCase();
    const normalizedFileName = (fileName || '').toLowerCase();
    const extension = path.extname(normalizedFileName);

    return {
      mimeType: normalizedMimeType,
      fileName: normalizedFileName,
      extension,
    };
  }

  isSupported(mimeType = '', fileName = '') {
    const fileInfo = this.getFileInfo(mimeType, fileName);

    if (['.pdf', '.doc', '.docx', '.txt', '.md', '.json', '.xml', '.html', '.css', '.js'].includes(fileInfo.extension)) {
      return true;
    }

    return config.extraction.supportedMimeTypes.some((supportedType) =>
      fileInfo.mimeType.includes(supportedType) ||
      fileInfo.mimeType.startsWith(`${supportedType.split('/')[0]}/`)
    );
  }

  async extractText(filePath, mimeType, fileName = '') {
    const result = await this.extractTextWithMetadata(filePath, mimeType, fileName);
    return result.text || '';
  }

  async extractTextWithMetadata(filePath, mimeType, fileName = '') {
    try {
      if (!await fs.pathExists(filePath)) {
        return {
          text: '',
          method: '',
          error: 'File not found.',
        };
      }

      const fileInfo = this.getFileInfo(mimeType, fileName || filePath);

      if (fileInfo.mimeType.includes('pdf') || fileInfo.extension === '.pdf') {
        return this.extractPdfTextWithMetadata(filePath);
      }

      if (
        fileInfo.mimeType.includes('word') ||
        fileInfo.mimeType.includes('document') ||
        fileInfo.mimeType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml') ||
        fileInfo.extension === '.docx' ||
        fileInfo.extension === '.doc'
      ) {
        const text = await this.extractFromWord(filePath);
        return {
          text,
          method: 'mammoth',
          error: text ? '' : 'No text could be extracted from this Word document.',
        };
      }

      if (
        fileInfo.mimeType.startsWith('text/') ||
        fileInfo.mimeType.includes('json') ||
        fileInfo.mimeType.includes('xml') ||
        fileInfo.mimeType.includes('javascript') ||
        fileInfo.mimeType.includes('css') ||
        fileInfo.mimeType.includes('html') ||
        ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js'].includes(fileInfo.extension)
      ) {
        const text = await this.extractFromText(filePath);
        return {
          text,
          method: 'plain-text',
          error: text ? '' : 'No text could be extracted from this text file.',
        };
      }

      if (fileInfo.mimeType.startsWith('image/')) {
        const text = await this.extractFromImage(filePath);
        return {
          text,
          method: 'tesseract-image',
          error: text ? '' : 'No text could be extracted from this image.',
        };
      }

      return {
        text: '',
        method: '',
        error: 'Unsupported file type for text extraction.',
      };
    } catch (error) {
      console.error('[TextExtractor] Error extracting text:', error);
      return {
        text: '',
        method: '',
        error: error.message || 'Unknown extraction error.',
      };
    }
  }

  isPdfLowSignal(text, numPages = 1) {
    const normalizedText = (text || '').trim();
    if (!normalizedText) {
      return true;
    }

    const charCount = normalizedText.length;
    const avgCharsPerPage = charCount / Math.max(1, numPages);

    return charCount < 120 || avgCharsPerPage < 80;
  }

  toPdfUint8Array(dataBuffer) {
    return new Uint8Array(dataBuffer);
  }

  async extractPdfTextWithMetadata(filePath) {
    const dataBuffer = await fs.readFile(filePath);
    const nativeResult = await this.extractPdfNative(dataBuffer);

    let bestText = (nativeResult.text || '').trim();
    let bestMethod = nativeResult.method || '';
    const numPages = nativeResult.numPages || 1;

    if (!this.isPdfLowSignal(bestText, numPages)) {
      return {
        text: bestText,
        method: bestMethod || 'pdf-parse',
        error: '',
      };
    }

    const ollamaOcrText = await this.extractFromScannedPDFWithOllama(filePath, dataBuffer, Math.min(numPages || 20, 20));
    if (ollamaOcrText && ollamaOcrText.trim().length > bestText.length) {
      bestText = ollamaOcrText.trim();
      bestMethod = 'ollama-ocr';
    }

    if (this.isPdfLowSignal(bestText, numPages)) {
      const tesseractText = await this.extractFromScannedPDF(filePath, dataBuffer, Math.min(numPages || 20, 20));
      if (tesseractText && tesseractText.trim().length > bestText.length) {
        bestText = tesseractText.trim();
        bestMethod = 'tesseract-ocr';
      }
    }

    return {
      text: bestText,
      method: bestMethod,
      error: bestText ? '' : 'No text could be extracted from this PDF.',
    };
  }

  async extractPdfNative(dataBuffer) {
    let bestText = '';
    let bestMethod = '';
    let numPages = 0;

    try {
      const parser = new PDFParse({ data: dataBuffer });
      try {
        const parsed = await parser.getText();
        const text = (parsed.text || '').trim();
        if (text.length > bestText.length) {
          bestText = text;
          bestMethod = 'pdf-parse';
        }
        numPages = parsed.total || numPages;
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      console.error('[PDF Extract] pdf-parse error:', error.message);
    }

    if (pdfjsLib) {
      try {
        const loadingTask = pdfjsLib.getDocument({ data: this.toPdfUint8Array(dataBuffer) });
        const pdf = await loadingTask.promise;
        numPages = pdf.numPages || numPages;

        let fullText = '';
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent();
          const pageText = (textContent.items || [])
            .map((item) => item.str || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          if (pageText) {
            fullText += `${fullText ? '\n' : ''}${pageText}`;
          }
        }

        if (fullText.trim().length > bestText.length) {
          bestText = fullText.trim();
          bestMethod = 'pdfjs-dist';
        }
      } catch (error) {
        console.error('[PDF Extract] pdfjs-dist error:', error.message);
      }
    }

    return {
      text: bestText,
      method: bestMethod,
      numPages,
    };
  }

  cleanOcrText(text) {
    if (!text) {
      return '';
    }

    return text
      .replace(/^```(?:text)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^here(?:'s| is) (?:the )?(?:extracted )?text:?\s*/i, '')
      .trim();
  }

  async renderPdfPageToBase64(page) {
    if (!createCanvas) {
      return '';
    }

    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    return canvas.toBuffer('image/png').toString('base64');
  }

  async extractFromScannedPDFWithOllama(filePath, dataBuffer, maxPages = 20) {
    if (!pdfjsLib || !createCanvas || !config.ollama.enabled) {
      return '';
    }

    try {
      const health = await ollamaClient.health();
      if (!health.available || !health.ocrModelAvailable) {
        return '';
      }

      const loadingTask = pdfjsLib.getDocument({ data: this.toPdfUint8Array(dataBuffer) });
      const pdf = await loadingTask.promise;
      const pageCount = Math.min(pdf.numPages, maxPages);
      let fullText = '';

      for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
        try {
          const page = await pdf.getPage(pageNum);
          const base64Image = await this.renderPdfPageToBase64(page);
          if (!base64Image) {
            continue;
          }

          const pageText = await ollamaClient.chat({
            task: 'ocr',
            model: config.ollama.ocrModel,
            content: 'Extract all readable text from this document page in natural reading order. Return only the text, with no commentary or markdown fences.',
            images: [base64Image],
          });

          const cleanText = this.cleanOcrText(pageText);
          if (cleanText) {
            fullText += `${fullText ? '\n\n' : ''}--- Page ${pageNum} ---\n${cleanText}`;
          }
        } catch (error) {
          console.error(`[PDF OCR] Ollama OCR failed on page ${pageNum}:`, error.message);
        }
      }

      return fullText.trim();
    } catch (error) {
      console.error('[PDF OCR] Ollama OCR failed:', error.message);
      return '';
    }
  }

  async extractFromScannedPDF(filePath, dataBuffer, maxPages = 20) {
    if (!pdfjsLib || !createCanvas) {
      return '';
    }

    try {
      const loadingTask = pdfjsLib.getDocument({ data: this.toPdfUint8Array(dataBuffer) });
      const pdf = await loadingTask.promise;
      const pageCount = Math.min(pdf.numPages, maxPages);
      let fullText = '';

      for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
        try {
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: 3.0 });
          const canvas = createCanvas(viewport.width, viewport.height);
          const context = canvas.getContext('2d');

          await page.render({
            canvasContext: context,
            viewport,
          }).promise;

          const imageBuffer = canvas.toBuffer('image/png');
          const pageText = await ocrImage(imageBuffer, `PDF OCR page ${pageNum}`);
          const cleanText = pageText;
          if (cleanText) {
            fullText += `${fullText ? '\n\n' : ''}--- Page ${pageNum} ---\n${cleanText}`;
          }
        } catch (error) {
          console.error(`[PDF OCR] Tesseract OCR failed on page ${pageNum}:`, error.message);
        }
      }

      return fullText.trim();
    } catch (error) {
      console.error('[PDF OCR] Tesseract OCR failed:', error.message);
      return '';
    }
  }

  async extractFromPDFAlternative() {
    return '';
  }

  async extractFromWord(filePath) {
    try {
      const rawResult = await mammoth.extractRawText({ path: filePath });
      const rawText = (rawResult.value || '').trim();
      if (rawText) {
        return rawText;
      }
    } catch (error) {
      console.error('[Word Extract] extractRawText failed:', error.message);
    }

    try {
      const htmlResult = await mammoth.convertToHtml({ path: filePath });
      const htmlText = (htmlResult.value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return htmlText;
    } catch (error) {
      console.error('[Word Extract] convertToHtml failed:', error.message);
      return '';
    }
  }

  async extractFromText(filePath) {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      console.error('[Text Extract] Error reading text file:', error.message);
      return '';
    }
  }

  async extractFromImage(filePath) {
    try {
      return await ocrImage(filePath, 'Image OCR');
    } catch (error) {
      console.error('[Image OCR] Error extracting text from image:', error.message);
      return '';
    }
  }
}

module.exports = new TextExtractor();
