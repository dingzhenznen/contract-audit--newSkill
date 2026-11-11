import { writeFileSync } from 'node:fs';

function buildSamplePdf() {
  const pages = [
    'PDF to Image Test - Page 1',
    'PDF to Image Test - Page 2',
  ];

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  for (const [index, title] of pages.entries()) {
    const text = `BT /F1 26 Tf 72 760 Td (${title}) Tj ET\nBT /F1 14 Tf 72 720 Td (Generated for smoke testing - line ${index + 1}) Tj ET`;
    const contentId = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const samplePdf = buildSamplePdf();

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('./sample.pdf', import.meta.url), samplePdf);
  console.log('wrote test/sample.pdf');
}
