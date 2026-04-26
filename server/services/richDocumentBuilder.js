const cheerio = require('cheerio');
const docx = require('docx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const normalizeWhitespace = (value = '') => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');

const getAlignment = ($node) => {
  const style = ($node.attr('style') || '').toLowerCase();
  const align = ($node.attr('align') || '').toLowerCase();

  if (style.includes('text-align:center') || align === 'center') {
    return 'center';
  }

  if (style.includes('text-align:right') || align === 'right') {
    return 'right';
  }

  return 'left';
};

const mergeRuns = (runs) => {
  const merged = [];

  runs.forEach((run) => {
    if (!run) {
      return;
    }

    if (run.break) {
      merged.push(run);
      return;
    }

    if (!run.text) {
      return;
    }

    const previous = merged[merged.length - 1];
    const sameStyle =
      previous &&
      !previous.break &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.underline === run.underline &&
      previous.strike === run.strike &&
      previous.code === run.code &&
      previous.link === run.link;

    if (sameStyle) {
      previous.text += run.text;
      return;
    }

    merged.push({ ...run });
  });

  return merged;
};

const parseInlineNodes = ($, nodes, marks = {}) =>
  mergeRuns(
    nodes.flatMap((node) => {
      if (node.type === 'text') {
        const text = normalizeWhitespace(node.data || '');
        return text.trim().length > 0 ? [{ ...marks, text }] : [];
      }

      if (node.type !== 'tag') {
        return [];
      }

      const $node = $(node);
      const tag = node.tagName.toLowerCase();

      if (tag === 'br') {
        return [{ break: true }];
      }

      const nextMarks = { ...marks };

      if (tag === 'strong' || tag === 'b') {
        nextMarks.bold = true;
      }

      if (tag === 'em' || tag === 'i') {
        nextMarks.italic = true;
      }

      if (tag === 'u') {
        nextMarks.underline = true;
      }

      if (tag === 's' || tag === 'strike') {
        nextMarks.strike = true;
      }

      if (tag === 'code') {
        nextMarks.code = true;
      }

      if (tag === 'a') {
        nextMarks.link = $node.attr('href') || '';
      }

      return parseInlineNodes($, $node.contents().toArray(), nextMarks);
    }),
  );

const createParagraphBlock = (runs, alignment = 'left', kind = 'paragraph', level = 0) => ({
  type: kind,
  alignment,
  level,
  runs: runs.length > 0 ? runs : [{ text: ' ' }],
});

const buildBlocksFromHtml = (html = '') => {
  const safeHtml = typeof html === 'string' && html.trim().length > 0 ? html : '<p></p>';
  const $ = cheerio.load(`<body>${safeHtml}</body>`);
  const blocks = [];

  const appendNode = (node) => {
    if (node.type === 'text') {
      const text = normalizeWhitespace($(node).text() || '');
      if (text.trim().length > 0) {
        blocks.push(createParagraphBlock([{ text }]));
      }
      return;
    }

    if (node.type !== 'tag') {
      return;
    }

    const $node = $(node);
    const tag = node.tagName.toLowerCase();
    const alignment = getAlignment($node);

    if (tag === 'ul' || tag === 'ol') {
      $node.children('li').each((_, li) => {
        const runs = parseInlineNodes($, $(li).contents().toArray());
        blocks.push({
          type: 'list-item',
          ordered: tag === 'ol',
          alignment,
          level: 0,
          runs: runs.length > 0 ? runs : [{ text: ' ' }],
        });
      });
      return;
    }

    if (tag === 'blockquote') {
      const runs = parseInlineNodes($, $node.contents().toArray()).map((run) =>
        run.break ? run : { ...run, italic: run.italic ?? true },
      );
      blocks.push(createParagraphBlock(runs, alignment, 'blockquote'));
      return;
    }

    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      const runs = parseInlineNodes($, $node.contents().toArray());
      blocks.push(createParagraphBlock(runs, alignment, 'heading', Number(tag[1])));
      return;
    }

    if (tag === 'p' || tag === 'div') {
      const runs = parseInlineNodes($, $node.contents().toArray());
      blocks.push(createParagraphBlock(runs, alignment));
      return;
    }

    if (tag === 'br') {
      blocks.push(createParagraphBlock([{ text: ' ' }], alignment));
      return;
    }

    const childTags = $node.children().toArray();
    if (childTags.length > 0) {
      childTags.forEach(appendNode);
      return;
    }

    const runs = parseInlineNodes($, $node.contents().toArray());
    if (runs.length > 0) {
      blocks.push(createParagraphBlock(runs, alignment));
    }
  };

  $('body')
    .contents()
    .toArray()
    .forEach(appendNode);

  return blocks.length > 0 ? blocks : [createParagraphBlock([{ text: ' ' }])];
};

const htmlToPlainText = (html = '') =>
  buildBlocksFromHtml(html)
    .map((block) => {
      const prefix = block.type === 'list-item' ? (block.ordered ? '1. ' : '• ') : '';
      return `${prefix}${block.runs.map((run) => (run.break ? '\n' : run.text || '')).join('')}`.trimEnd();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const getDocxAlignment = (alignment) => {
  if (alignment === 'center') {
    return docx.AlignmentType.CENTER;
  }

  if (alignment === 'right') {
    return docx.AlignmentType.RIGHT;
  }

  return docx.AlignmentType.LEFT;
};

const buildDocxChildren = (runs) => {
  const children = [];
  let pendingBreaks = 0;

  runs.forEach((run) => {
    if (run.break) {
      pendingBreaks += 1;
      return;
    }

    const textRun = new docx.TextRun({
      text: run.text || ' ',
      bold: Boolean(run.bold),
      italics: Boolean(run.italic),
      strike: Boolean(run.strike),
      break: pendingBreaks || undefined,
      underline: run.underline ? { type: docx.UnderlineType.SINGLE } : undefined,
      font: run.code ? 'Courier New' : undefined,
      color: run.link ? '1f56c3' : undefined,
    });

    pendingBreaks = 0;

    if (run.link) {
      children.push(
        new docx.ExternalHyperlink({
          link: run.link,
          children: [textRun],
        }),
      );
      return;
    }

    children.push(textRun);
  });

  if (pendingBreaks > 0) {
    children.push(
      new docx.TextRun({
        text: ' ',
        break: pendingBreaks,
      }),
    );
  }

  return children.length > 0 ? children : [new docx.TextRun(' ')];
};

const buildDocxBufferFromHtml = async (html = '') => {
  const blocks = buildBlocksFromHtml(html);
  const children = blocks.map((block) => {
    const baseConfig = {
      alignment: getDocxAlignment(block.alignment),
      spacing: {
        after: block.type === 'heading' ? 160 : 120,
        line: block.type === 'heading' ? 300 : 340,
      },
      children: buildDocxChildren(block.runs),
    };

    if (block.type === 'heading') {
      const headingLevel =
        block.level === 1
          ? docx.HeadingLevel.HEADING_1
          : block.level === 2
            ? docx.HeadingLevel.HEADING_2
            : docx.HeadingLevel.HEADING_3;

      return new docx.Paragraph({
        ...baseConfig,
        heading: headingLevel,
      });
    }

    if (block.type === 'blockquote') {
      return new docx.Paragraph({
        ...baseConfig,
        indent: { left: 720 },
      });
    }

    if (block.type === 'list-item') {
      return new docx.Paragraph({
        ...baseConfig,
        numbering: {
          reference: block.ordered ? 'editor-numbered-list' : 'editor-bullet-list',
          level: 0,
        },
      });
    }

    return new docx.Paragraph(baseConfig);
  });

  const document = new docx.Document({
    numbering: {
      config: [
        {
          reference: 'editor-bullet-list',
          levels: [
            {
              level: 0,
              format: 'bullet',
              text: '\u2022',
              alignment: docx.AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: 720, hanging: 360 },
                },
              },
            },
          ],
        },
        {
          reference: 'editor-numbered-list',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: docx.AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: 720, hanging: 360 },
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return docx.Packer.toBuffer(document);
};

const wrapText = (text, font, size, maxWidth) => {
  const cleanText = text.replace(/\u00a0/g, ' ');
  const paragraphs = cleanText.split('\n');
  const lines = [];

  paragraphs.forEach((paragraph) => {
    const words = paragraph.trim().length > 0 ? paragraph.trim().split(/\s+/) : [];

    if (words.length === 0) {
      lines.push('');
      return;
    }

    let currentLine = words[0];

    words.slice(1).forEach((word) => {
      const candidate = `${currentLine} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        currentLine = candidate;
        return;
      }

      lines.push(currentLine);
      currentLine = word;
    });

    if (currentLine) {
      lines.push(currentLine);
    }
  });

  return lines.length > 0 ? lines : [''];
};

const getPdfFont = (fonts, block) => {
  if (block.type === 'heading') {
    return fonts.bold;
  }

  if (block.type === 'blockquote') {
    return fonts.italic;
  }

  return fonts.regular;
};

const getPdfStyle = (block) => {
  if (block.type === 'heading') {
    if (block.level === 1) {
      return { size: 20, lineHeight: 28, indent: 56 };
    }

    if (block.level === 2) {
      return { size: 16, lineHeight: 24, indent: 56 };
    }

    return { size: 14, lineHeight: 22, indent: 56 };
  }

  if (block.type === 'blockquote') {
    return { size: 11, lineHeight: 18, indent: 82 };
  }

  if (block.type === 'list-item') {
    return { size: 11.5, lineHeight: 18, indent: 76 };
  }

  return { size: 11.5, lineHeight: 18, indent: 56 };
};

const buildPdfBytesFromHtml = async (html = '') => {
  const blocks = buildBlocksFromHtml(html);
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.TimesRoman),
    bold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
    italic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
  };

  const pageSize = [612, 792];
  const marginTop = 56;
  const marginBottom = 56;
  const marginRight = 56;
  let page = pdfDoc.addPage(pageSize);
  let y = page.getHeight() - marginTop;

  const ensureSpace = (requiredHeight) => {
    if (y - requiredHeight >= marginBottom) {
      return;
    }

    page = pdfDoc.addPage(pageSize);
    y = page.getHeight() - marginTop;
  };

  blocks.forEach((block, index) => {
    const style = getPdfStyle(block);
    const font = getPdfFont(fonts, block);
    const prefix = block.type === 'list-item' ? (block.ordered ? '1. ' : '• ') : '';
    const text = `${prefix}${block.runs.map((run) => (run.break ? '\n' : run.text || '')).join('')}`.trimEnd() || ' ';
    const maxWidth = page.getWidth() - style.indent - marginRight;
    const lines = wrapText(text, font, style.size, maxWidth);
    const blockHeight = lines.length * style.lineHeight + (index < blocks.length - 1 ? 8 : 0);

    ensureSpace(blockHeight);

    lines.forEach((line) => {
      const width = font.widthOfTextAtSize(line || ' ', style.size);
      const x =
        block.alignment === 'center'
          ? (page.getWidth() - width) / 2
          : block.alignment === 'right'
            ? page.getWidth() - marginRight - width
            : style.indent;

      page.drawText(line || ' ', {
        x,
        y,
        size: style.size,
        font,
        color: rgb(0.13, 0.16, 0.22),
      });
      y -= style.lineHeight;
    });

    y -= 8;
  });

  return pdfDoc.save();
};

module.exports = {
  buildBlocksFromHtml,
  buildDocxBufferFromHtml,
  buildPdfBytesFromHtml,
  htmlToPlainText,
};
