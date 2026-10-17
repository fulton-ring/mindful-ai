import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { DOCUMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../../chat/attachments/attachments';
import type {
  DocumentExtraction,
  DocumentExtractionInput,
} from '../../../storage/document-extractor';

const MAX_OUTPUT = 4_000_000;
export function htmlToMarkdown(html: string): string {
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.use(gfm);
  converter.remove(['script', 'style', 'iframe']);
  return converter.turndown(html);
}
/** Check ZIP expansion before handing OOXML to a parser, including archives with ZIP64 markers. */
function validateArchive(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('Malformed document archive.');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  let expanded = 0;
  const directoryStart = offset;
  if (count === 0xffff || count > 10000 || view.getUint16(end + 4, true) !== 0)
    throw new Error('Document archive is too complex.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Malformed document archive.');
    if (view.getUint16(offset + 8, true) & 1)
      throw new Error('Encrypted documents are unsupported.');
    expanded += expandedEntry(bytes, view, offset, directoryStart, 32_000_000 - expanded);
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
}
function expandedEntry(
  bytes: Uint8Array,
  view: DataView,
  central: number,
  directory: number,
  remaining: number,
): number {
  const declared = view.getUint32(central + 24, true);
  if (declared > 16_000_000) throw new Error('Expanded document entry exceeds the 16 MB limit.');
  if (declared > remaining) throw new Error('Expanded document exceeds the 32 MB limit.');
  const local = view.getUint32(central + 42, true);
  if (local + 30 > directory || view.getUint32(local, true) !== 0x04034b50)
    throw new Error('Malformed document archive.');
  const method = view.getUint16(central + 10, true);
  if (
    (method !== 0 && method !== 8) ||
    view.getUint16(local + 8, true) !== method ||
    view.getUint16(local + 6, true) & 1
  )
    throw new Error('Unsupported document archive compression.');
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const end = start + view.getUint32(central + 20, true);
  if (start > directory || end > directory) throw new Error('Malformed document archive.');
  const compressed = bytes.subarray(start, end);
  let length: number;
  try {
    length =
      method === 0
        ? compressed.byteLength
        : inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, Math.min(16_000_000, remaining)),
          }).byteLength;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
      throw new Error('Expanded document entry exceeds the 16 MB limit.');
    throw error;
  }
  if (length !== declared) throw new Error('Malformed document archive size.');
  return length;
}
function bounded(markdown: string): DocumentExtraction {
  if (markdown.length > MAX_OUTPUT) throw new Error('Extracted document exceeds the text limit.');
  if (!markdown.trim())
    throw new Error('Document contains no extractable text. Scanned PDFs need OCR before upload.');
  return { markdown };
}
function tableCell(value: string) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
export async function convertDocument(input: DocumentExtractionInput): Promise<DocumentExtraction> {
  input.signal?.throwIfAborted();
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error('Documents must be between 1 byte and 1 MB.');
  const extension = /\.([a-z0-9]+)$/i.exec(input.name)?.[1]?.toLowerCase();
  if (!extension || DOCUMENT_TYPES[extension] !== input.mimeType)
    throw new Error('Unsupported document format. Use PDF, DOCX, or XLSX.');
  if (extension === 'pdf') return convertPdf(input);
  validateArchive(input.bytes);
  if (extension === 'docx') {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(input.bytes) },
      { externalFileAccess: false },
    );
    input.signal?.throwIfAborted();
    return bounded(htmlToMarkdown(result.value));
  }
  return convertSpreadsheet(input);
}

async function convertPdf(input: DocumentExtractionInput): Promise<DocumentExtraction> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: Uint8Array.from(input.bytes),
    useSystemFonts: true,
    verbosity: 0,
  });
  const abort = () => {
    void task.destroy();
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 200) throw new Error('PDF exceeds the 200 page limit.');
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      input.signal?.throwIfAborted();
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      pages.push(
        `## Page ${pageNo}\n\n` +
          content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('')
            .trim(),
      );
      if (pages.reduce((sum, page) => sum + page.length, 0) > MAX_OUTPUT)
        throw new Error('Extracted document exceeds the text limit.');
      page.cleanup();
    }
    if (pages.every((page) => /^## Page \d+\s*$/.test(page)))
      throw new Error(
        'Document contains no extractable text. Scanned PDFs need OCR before upload.',
      );
    return bounded(pages.join('\n\n'));
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}

async function convertSpreadsheet(input: DocumentExtractionInput): Promise<DocumentExtraction> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(input.bytes));
  const parts: string[] = [];
  let cellCount = 0;
  for (const sheet of workbook.worksheets) {
    input.signal?.throwIfAborted();
    if (sheet.rowCount > 10000 || sheet.columnCount > 256)
      throw new Error('Spreadsheet exceeds the row or column limit.');
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (++cellCount > 100000) throw new Error('Spreadsheet exceeds the cell limit.');
        cells.push(tableCell(cell.text));
      });
      rows.push(cells);
    });
    if (!rows.length) continue;
    const width = Math.max(...rows.map((row) => row.length));
    const format = (row: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
    parts.push(
      `## ${sheet.name}\n\n${format(rows[0])}\n${format(Array(width).fill('---'))}\n${rows.slice(1).map(format).join('\n')}`,
    );
    if (parts.reduce((sum, part) => sum + part.length, 0) > MAX_OUTPUT)
      throw new Error('Extracted document exceeds the text limit.');
  }
  return bounded(parts.join('\n\n'));
}
