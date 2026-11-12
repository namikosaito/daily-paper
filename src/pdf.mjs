import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

export async function readPdfFirstPageLines(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false,
  }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], text: item.str });
    }
    return [...rows.entries()].sort((a, b) => b[0] - a[0])
      .map(([, row]) => row.sort((a, b) => a.x - b.x).map(item => item.text).join(' '));
  } finally {
    await document.destroy();
  }
}

export async function renderPdfPreview(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false,
  }).promise;
  try {
    let pageNumber = 1;
    for (let number = 1; number <= Math.min(document.numPages, 5); number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.filter(item => 'str' in item).map(item => item.str).join(' ');
      if (/\b(?:figure|fig\.?)\s*1\b/i.test(text)) {
        pageNumber = number;
        break;
      }
    }
    const page = await document.getPage(pageNumber);
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(1.7, 1800 / Math.max(original.width, original.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    return {
      bytes: canvas.toBuffer('image/png'), extension: 'png', method: 'pdf-page', pageNumber,
      caption: `PDF ${pageNumber}ページのプレビュー（図の切り抜きではありません）。`,
    };
  } finally {
    await document.destroy();
  }
}
