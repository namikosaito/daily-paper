import { load } from 'cheerio';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readPdfFirstPageLines, renderPdfPreview } from './pdf.mjs';
import { extractHtmlAffiliations, extractPdfAffiliations } from './affiliations.mjs';

const normalize = value => value.replace(/\s+/g, ' ').trim();
const unavailable = reason => ({ status: 'unavailable', reason });
const userAgent = 'daily-paper/1.0 (personal robotics digest)';
const allowedOrigins = new Set(['https://arxiv.org', 'https://ar5iv.labs.arxiv.org', 'https://aclanthology.org']);
const publisherPages = { '1810.04805': 'https://aclanthology.org/N19-1423/' };
const scholarlyFigureGrant = 'Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.';
let nextRequestAt = 0;

export function reusableLicense(href) {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'creativecommons.org') return null;
    if (!/^\/(?:licenses\/by(?:-sa)?\/[34]\.0|publicdomain\/zero\/1\.0)\/?$/.test(url.pathname)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function extractPaperSource(html, abstractUrl) {
  const $ = load(html);
  const licenseUrl = $('a[href]').toArray().map(node => reusableLicense($(node).attr('href'))).find(Boolean);
  const htmlHref = $('a[href]').toArray().map(node => $(node).attr('href')).find(href => {
    const url = new URL(href, abstractUrl);
    return url.origin === 'https://arxiv.org' && /^\/html\/\d{4}\.\d{4,5}(?:v\d+)?$/.test(url.pathname);
  });
  return { licenseUrl, htmlUrl: htmlHref ? new URL(htmlHref, abstractUrl).href : null };
}

export function extractFigure(html, htmlUrl) {
  const $ = load(html);
  for (const figure of $('figure.ltx_figure').toArray()) {
    for (const image of $(figure).find('img[src]').toArray()) {
      const url = new URL($(image).attr('src'), htmlUrl);
      if (!['https://arxiv.org', 'https://ar5iv.labs.arxiv.org'].includes(url.origin)
        || url.origin !== new URL(htmlUrl).origin
        || !url.pathname.startsWith('/html/')
        || !/\.(png|jpe?g|webp)$/i.test(url.pathname)) continue;
      return {
        url: url.href,
        caption: normalize($(figure).find('figcaption').text()).slice(0, 1500),
      };
    }
  }
  return null;
}

export function extractPublisherSource(html, paper) {
  const $ = load(html);
  const titleKey = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (titleKey($('meta[name="citation_title"]').attr('content')) !== titleKey(paper.title)) {
    throw new Error(`出版版のタイトルがarXiv論文と一致しません: ${paper.id}`);
  }
  const licenseUrl = reusableLicense($('[rel="license"][href]').attr('href'));
  const pdfUrl = $('meta[name="citation_pdf_url"]').attr('content');
  if (!licenseUrl || !pdfUrl) return null;
  const pdf = new URL(pdfUrl);
  if (pdf.origin !== 'https://aclanthology.org' || !/^\/[A-Za-z0-9.-]+\.pdf$/.test(pdf.pathname)) {
    throw new Error('出版版PDFの取得先が許可されていません。');
  }
  return { licenseUrl, pdfUrl: pdf.href };
}

export function permitsScholarlyFigures(text) {
  return normalize(text).includes(scholarlyFigureGrant);
}

export function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('対応するPNG/JPEG/WebP画像ではありません。');
}

async function request(url, binary = false, sizeLimit) {
  if (!allowedOrigins.has(new URL(url).origin)) throw new Error('図の取得先が許可されていません。');
  const delay = nextRequestAt - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  nextRequestAt = Date.now() + 3100;
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { error: `HTTP ${response.status}` };
  }
  if (!allowedOrigins.has(new URL(response.url).origin)) {
    await response.body?.cancel();
    throw new Error('画像取得先が許可されていないサイトへリダイレクトされました。');
  }
  const maxBytes = sizeLimit ?? (binary ? 12 * 1024 * 1024 : 8 * 1024 * 1024);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('図の取得先の応答がサイズ上限を超えています。');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return binary ? { bytes } : { html: bytes.toString('utf8') };
}

async function savePreview(paper, root, preview, rights) {
  const filename = `${paper.id.replaceAll('/', '_')}.${preview.extension}`;
  const directory = path.join(root, 'figures');
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, filename);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, preview.bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    status: 'available', src: `figures/${filename}`,
    caption: preview.caption, sourceUrl: preview.sourceUrl, originalUrl: preview.originalUrl, ...rights,
    method: preview.method, ...(preview.pageNumber ? { pageNumber: preview.pageNumber } : {}),
    credit: `${paper.authors.join(', ')} · arXiv:${paper.id}`,
  };
}

async function fetchPublisherFigure(paper, root) {
  const pageUrl = publisherPages[paper.id];
  if (!pageUrl) return null;
  const page = await request(pageUrl);
  if (page.error) {
    console.warn(`${paper.id}: 出版版のライセンスを確認できません（${page.error}）。`);
    return null;
  }
  const source = extractPublisherSource(page.html, paper);
  if (!source) {
    console.warn(`${paper.id}: 出版版の明示的な再利用ライセンスまたはPDFがありません。`);
    return null;
  }
  const pdf = await request(source.pdfUrl, true, 40 * 1024 * 1024);
  if (pdf.error) {
    console.warn(`${paper.id}: 出版版のPDFを取得できません（${pdf.error}）。`);
    return null;
  }
  return savePreview(paper, root, {
    ...await renderPdfPreview(pdf.bytes), sourceUrl: source.pdfUrl, originalUrl: source.pdfUrl,
  }, { licenseUrl: source.licenseUrl, licenseEvidenceUrl: pageUrl });
}

async function fetchScholarlyFigure(paper, root, firstPageLines) {
  if (!permitsScholarlyFigures(firstPageLines.join(' '))) return null;
  const htmlUrl = `https://ar5iv.labs.arxiv.org/html/${paper.id}`;
  const article = await request(htmlUrl);
  if (article.error) {
    console.warn(`${paper.id}: 図の転載許可は確認できましたが、HTMLを取得できません（${article.error}）。`);
    return null;
  }
  if (!permitsScholarlyFigures(load(article.html).text())) {
    console.warn(`${paper.id}: HTML版では同じ図の転載許可を確認できません。`);
    return null;
  }
  const candidate = extractFigure(article.html, htmlUrl);
  if (!candidate) {
    console.warn(`${paper.id}: 転載許可のあるHTML版に対応する図がありません。`);
    return null;
  }
  const image = await request(candidate.url, true);
  if (image.error) {
    console.warn(`${paper.id}: 転載許可のある図を取得できません（${image.error}）。`);
    return null;
  }
  return savePreview(paper, root, {
    bytes: image.bytes, extension: imageExtension(image.bytes), method: 'html-figure',
    caption: candidate.caption, sourceUrl: htmlUrl, originalUrl: candidate.url,
  }, { permission: { kind: 'scholarly-figures', statement: scholarlyFigureGrant, sourceUrl: paper.pdfUrl } });
}

async function fetchPaperAssets(paper, root) {
  let figure = paper.figure?.status === 'available' ? paper.figure : null;
  let affiliations = paper.affiliations?.status === 'available' ? paper.affiliations : null;
  const apiInstitutions = [...new Set((paper.authorAffiliations ?? []).flatMap(author => author.institutions))];
  if (!affiliations && apiInstitutions.length) affiliations = {
    status: 'available', institutions: apiInstitutions, sourceUrl: paper.url, method: 'arxiv-api',
  };
  if (!figure) figure = await fetchPublisherFigure(paper, root);
  if (figure && affiliations) return { figure, affiliations };
  const abstract = await request(paper.url);
  if (abstract.error) return {
    figure: figure ?? unavailable(`論文ページを取得できません（${abstract.error}）。`),
    affiliations: affiliations ?? unavailable(`所属を取得できません（${abstract.error}）。`),
  };
  const { licenseUrl, htmlUrl } = extractPaperSource(abstract.html, paper.url);
  let preview;
  let article;
  if (htmlUrl) {
    article = await request(htmlUrl);
    if (!article.error && !affiliations) {
      const institutions = extractHtmlAffiliations(article.html);
      if (institutions.length) affiliations = { status: 'available', institutions, sourceUrl: htmlUrl, method: 'arxiv-html' };
    }
    const candidate = !licenseUrl || figure || article.error ? null : extractFigure(article.html, htmlUrl);
    if (candidate) {
      const image = await request(candidate.url, true);
      if (!image.error) preview = {
        bytes: image.bytes, extension: imageExtension(image.bytes), method: 'html-figure',
        caption: candidate.caption, sourceUrl: htmlUrl, originalUrl: candidate.url,
      };
    }
  }
  if ((!figure && !preview) || !affiliations) {
    const pdf = await request(paper.pdfUrl, true, 40 * 1024 * 1024);
    if (pdf.error) {
      if (!figure && !preview) figure = unavailable(`PDFで図の取得条件を確認できません（${pdf.error}）。`);
      affiliations ??= unavailable(`PDFで所属を確認できません（${pdf.error}）。`);
    } else {
      const firstPageLines = !affiliations || !licenseUrl ? await readPdfFirstPageLines(pdf.bytes) : [];
      if (!affiliations) {
        const institutions = extractPdfAffiliations(firstPageLines);
        if (institutions.length) affiliations = { status: 'available', institutions, sourceUrl: paper.pdfUrl, method: 'arxiv-pdf' };
      }
      if (!figure && licenseUrl && !preview) {
        preview = { ...await renderPdfPreview(pdf.bytes), sourceUrl: paper.pdfUrl, originalUrl: paper.pdfUrl };
      } else if (!figure && !preview) {
        figure = await fetchScholarlyFigure(paper, root, firstPageLines);
      }
    }
  }
  if (preview) figure = await savePreview(paper, root, preview, { licenseUrl });
  return {
    figure: figure ?? unavailable('図の再利用条件を確認できないため、原論文をご覧ください。'),
    affiliations: affiliations ?? unavailable('論文から所属を確認できませんでした。'),
  };
}

export async function attachFigures(papers, root) {
  const enriched = [];
  for (const paper of papers) {
    if (paper.figure?.status === 'available' && paper.affiliations?.status === 'available') {
      enriched.push(paper);
      continue;
    }
    let assets;
    try {
      assets = await fetchPaperAssets(paper, root);
    } catch (error) {
      if (!['TypeError', 'TimeoutError', 'AbortError', 'InvalidPDFException', 'MissingPDFException', 'UnexpectedResponseException', 'FormatError'].includes(error.name)) throw error;
      const failure = { status: 'error', reason: `図・所属の取得に失敗しました: ${error.message}` };
      assets = { figure: paper.figure?.status === 'available' ? paper.figure : failure,
        affiliations: paper.affiliations?.status === 'available' ? paper.affiliations : failure };
    }
    const { figure, affiliations } = assets;
    if (figure.status !== 'available') console.warn(`${paper.id}: ${figure.reason}`);
    else console.log(`${paper.id}: 代表図を保存しました。`);
    if (affiliations.status !== 'available') console.warn(`${paper.id}: ${affiliations.reason}`);
    enriched.push({ ...paper, figure, affiliations });
  }
  return enriched;
}
