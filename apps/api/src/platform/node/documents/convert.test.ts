import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { convertDocument, htmlToMarkdown } from './convert';

it('converts real XLSX cells including escaped Markdown tables', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Budget');
  sheet.addRow(['Item', 'Price']);
  sheet.addRow(['tea | coffee', 7]);
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  const result = await convertDocument({
    name: 'budget.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes,
  });
  expect(result.markdown).toContain('Budget');
  expect(result.markdown).toContain('tea \\| coffee');
  expect(result.markdown).toContain('7');
});
it('converts a real DOCX archive to Markdown with headings', async () => {
  const result = await convertDocument({
    name: 'paper.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: await readFile(new URL('./fixtures/paper.docx', import.meta.url)),
  });
  expect(result.markdown).toContain('violet otter 731');
});
it('converts an actual PDF text stream without a Cloudflare binding', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 72 720 Td (coral ibex 284) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  expect(
    (
      await convertDocument({
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        bytes: new TextEncoder().encode(pdf),
      })
    ).markdown,
  ).toContain('coral ibex 284');
});
it('rejects oversized and malformed documents and unsupported formats', async () => {
  await expect(
    convertDocument({
      name: 'x.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array(1_000_001),
    }),
  ).rejects.toThrow('1 MB');
  for (const [name, mimeType] of [
    ['x.pdf', 'application/pdf'],
    ['x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['x.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['x.exe', 'application/octet-stream'],
  ])
    await expect(
      convertDocument({ name, mimeType, bytes: new TextEncoder().encode('bad') }),
    ).rejects.toThrow();
});
it('shares HTML to Markdown conversion with research, including GFM tables', () => {
  expect(htmlToMarkdown('<table><tr><th>A</th></tr><tr><td>B</td></tr></table>')).toContain(
    '| A |',
  );
});

it('bounds actual ZIP inflation even when an archive lies about its expanded size', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const compressed = deflateRawSync(Buffer.alloc(17_000_000, 120));
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(1, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(1, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  const bytes = Buffer.concat([local, name, compressed, central, name, end]);
  expect(bytes.length).toBeLessThan(1_000_000);
  await expect(
    convertDocument({
      name: 'bomb.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes,
    }),
  ).rejects.toThrow('16 MB');
  expect(
    (
      await convertDocument({
        name: 'paper.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: await readFile(new URL('./fixtures/paper.docx', import.meta.url)),
      })
    ).markdown,
  ).toContain('violet otter 731');
});
