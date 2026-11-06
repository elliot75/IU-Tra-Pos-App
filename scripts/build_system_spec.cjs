#!/usr/bin/env node
/**
 * Generate the Word specification from the adjacent Markdown source.
 * Dependency: npm package `docx` (may be provided through NODE_PATH).
 * Usage: node scripts/build_system_spec.cjs [source.md] [output.docx]
 * Only this project's Markdown subset is supported; unsupported syntax fails.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, HeadingLevel, AlignmentType, WidthType, ShadingType,
  BorderStyle, TableLayoutType, PageNumber, TableOfContents,
  PageBreak, LevelFormat, VerticalAlign,
} = require('docx');

const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, 'IUTRA_POS_System_Specification_v1.0.md'));
const destination = path.resolve(process.argv[3] || path.join(root, 'IUTRA_POS_System_Specification_v1.0.docx'));
const markdown = fs.readFileSync(source, 'utf8');
const lines = markdown.split(/\r?\n/);
const RED = 'B9232B';
const INK = '20252B';
const MUTED = '616B75';
// LibreOffice on this Traditional Chinese macOS resolves the localized family name.
const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '蘋方-繁', cs: 'Arial' };
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1080;
const WIDTH = PAGE_WIDTH - MARGIN * 2;
const border = { style: BorderStyle.SINGLE, size: 4, color: 'DDE2E6' };

function runs(text, extra = {}) {
  // Inline code markers are typography, not document text.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map(part => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return new TextRun({ text: part.slice(1, -1), font: FONT, color: INK, ...extra });
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return new TextRun({ text: part.slice(2, -2), font: FONT, bold: true, ...extra });
    }
    return new TextRun({ text: part, font: FONT, ...extra });
  });
}
function para(text, opts = {}) {
  return new Paragraph({
    children: runs(text),
    spacing: { after: 120, line: 320 },
    widowControl: true,
    ...opts,
  });
}
function tableWidths(headers) {
  if (headers.length === 2) return [0.25, 0.75];
  if (headers.length === 4) return [0.25, 0.23, 0.25, 0.27];
  if (headers.length !== 3) throw new Error(`Unsupported table column count ${headers.length}`);
  if (headers[0] === '表') return [0.23, 0.43, 0.34];
  if (headers[0] === '欄位') return [0.29, 0.25, 0.46];
  if (headers[0].startsWith('端點')) return [0.34, 0.35, 0.31];
  if (headers[0].startsWith('案例')) return [0.25, 0.51, 0.24];
  return [0.23, 0.44, 0.33];
}
function makeTable(rows) {
  const ratios = tableWidths(rows[0]);
  const widths = ratios.map(r => Math.floor(r * WIDTH));
  widths[widths.length - 1] += WIDTH - widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: true,
      children: row.map((text, colIndex) => new TableCell({
        width: { size: widths[colIndex], type: WidthType.DXA },
        verticalAlign: VerticalAlign.TOP,
        margins: { top: 80, bottom: 80, left: 90, right: 90 },
        shading: { type: ShadingType.CLEAR, fill: rowIndex === 0 ? 'EDEFF2' : rowIndex % 2 === 0 ? 'F8F9FA' : 'FFFFFF' },
        children: [new Paragraph({
          children: runs(text, { size: 19, bold: rowIndex === 0, color: INK }),
          spacing: { after: 0, line: 250 },
          // Keep all cells of a header with the first data row.
          keepNext: rowIndex === 0,
          widowControl: true,
        })],
      })),
    })),
  });
}

const firstChapter = lines.findIndex(line => line.startsWith('## '));
if (firstChapter < 0) throw new Error('Missing chapters');
const coverLines = lines.slice(0, firstChapter).filter(line => line.trim());
const body = [];
let tables = 0;
let chapters = 0;
let inCode = false;
let codeLines = [];
for (let i = firstChapter; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith('```')) {
    if (!inCode) { inCode = true; codeLines = []; }
    else {
      codeLines.forEach(code => body.push(new Paragraph({
        children: [new TextRun({ text: code || ' ', font: 'Menlo', size: 17, color: INK })],
        spacing: { after: 0, line: 230 },
        indent: { left: 160, right: 160 },
        shading: { type: ShadingType.CLEAR, fill: 'F3F5F7' },
        keepNext: true,
      })));
      body.push(new Paragraph({ spacing: { after: 80 } }));
      inCode = false;
    }
    continue;
  }
  if (inCode) { codeLines.push(line); continue; }
  if (!line.trim()) continue;
  if (line.startsWith('## ')) {
    chapters++;
    body.push(para(line.slice(3), { heading: HeadingLevel.HEADING_1, outlineLevel: 0, spacing: { before: 420, after: 180, line: 360 } }));
  } else if (line.startsWith('### ')) {
    body.push(para(line.slice(4), { heading: HeadingLevel.HEADING_2, outlineLevel: 1 }));
  } else if (line.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) {
      const cells = lines[i].slice(1, -1).split('|').map(s => s.trim());
      if (!cells.every(s => /^:?-+:?$/.test(s))) rows.push(cells);
      i++;
    }
    i--;
    if (!rows.every(row => row.length === rows[0].length)) throw new Error(`Ragged table around line ${i}`);
    body.push(makeTable(rows));
    body.push(new Paragraph({ spacing: { after: 80, line: 80 }, children: [new TextRun({ text: '', size: 2 })] }));
    tables++;
  } else if (line.startsWith('- ')) {
    body.push(para(line.slice(2), { numbering: { reference: 'bullets', level: 0 } }));
  } else if (/^#{1,6} /.test(line)) {
    throw new Error(`Unsupported heading at line ${i + 1}`);
  } else {
    body.push(para(line));
  }
}
if (inCode) throw new Error('Unclosed code block');

const header = new Header({ children: [new Paragraph({
  children: [new TextRun({ text: 'IUTRA  /  SYSTEM SPECIFICATION', font: FONT, color: MUTED, size: 16 })],
  border: { bottom: { color: RED, style: BorderStyle.SINGLE, size: 8, space: 6 } },
  spacing: { after: 120 },
})] });
const footer = new Footer({ children: [new Paragraph({
  children: [
    new TextRun({ text: 'v1.0  ·  2026-11-05   |   ', size: 16, color: MUTED, font: FONT }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED, font: FONT }),
    new TextRun({ text: ' / ', size: 16, color: MUTED, font: FONT }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED, font: FONT }),
  ],
  alignment: AlignmentType.RIGHT,
})] });
const properties = { page: { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 480, footer: 480 } } };
const doc = new Document({
  creator: 'IUTRA', title: 'IUTRA POS 系統規格書 v1.0', subject: 'POS / PostgreSQL / 系統需求與設計規格',
  description: '依開發計劃書編製之繁體中文系統規格，區分確認需求、提案與待定決策。',
  styles: {
    default: {
      document: { run: { font: FONT, size: 22, color: INK }, paragraph: { spacing: { after: 120, line: 320 } } },
      title: { run: { font: FONT, size: 52, bold: true, color: INK }, paragraph: { spacing: { before: 0, after: 300 }, keepNext: true } },
      heading1: { run: { font: FONT, size: 32, bold: true, color: RED }, paragraph: { spacing: { before: 0, after: 240 }, keepNext: true } },
      heading2: { run: { font: FONT, size: 25, bold: true, color: INK }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
    },
    paragraphStyles: [
      { id: 'TOC1', name: 'toc 1', basedOn: 'Normal', run: { font: FONT, size: 22, color: INK }, paragraph: { spacing: { before: 120, after: 140, line: 320 } } },
    ],
  },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 320, hanging: 180 } } } }] }] },
  features: { updateFields: true },
  sections: [
    {
      properties,
      headers: { default: header }, footers: { default: footer },
      children: [
        new Paragraph({ children: [new TextRun({ text: 'IUTRA', font: FONT, size: 36, bold: true, color: RED })], spacing: { before: 1200, after: 200 } }),
        new Paragraph({ text: 'POS 系統規格書', heading: HeadingLevel.TITLE }),
        para('SYSTEM REQUIREMENTS & DESIGN SPECIFICATION', { spacing: { after: 600 } }),
        ...coverLines.slice(1).map((line, index) => para(line, { spacing: { after: index === 0 ? 360 : 240, line: 360 } })),
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ children: [new TextRun({ text: '目錄', font: FONT, size: 32, bold: true, color: RED })], spacing: { after: 300 } }),
        new TableOfContents('目錄', { hyperlink: true, headingStyleRange: '1-1' }),
        para('閱讀提示：C 為已確認；P 為原計劃提案；D 為新增設計建議；T 為待確認。各項功能另標示首版、後續或條件式範圍。', { spacing: { before: 360, after: 120, line: 340 } }),
        new Paragraph({ children: [new PageBreak()] }),
        ...body,
      ],
    },
  ],
});
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(destination, buffer);
  console.log(JSON.stringify({ output: destination, bytes: buffer.length, chapters, tables }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
