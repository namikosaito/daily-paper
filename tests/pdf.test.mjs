import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPdfPreview } from '../src/pdf.mjs';
import { imageExtension } from '../src/figures.mjs';

function examplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, title] of ['Introduction', 'Figure 1: Example diagram'].entries()) {
    const stream = `BT /F1 14 Tf 50 700 Td (${title}) Tj ET\n50 400 400 200 re S`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(document);
}

test('PDF fallback selects a page mentioning Figure 1 and renders a labeled PNG page preview', async () => {
  const preview = await renderPdfPreview(examplePdf());
  assert.equal(preview.pageNumber, 2);
  assert.equal(preview.method, 'pdf-page');
  assert.equal(imageExtension(preview.bytes), 'png');
  assert.ok(preview.bytes.length > 1000);
  assert.match(preview.caption, /切り抜きではありません/);
});
