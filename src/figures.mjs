import { load } from 'cheerio';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readPdfFirstPageLines, readPdfTextPages, renderPdfPreview } from './pdf.mjs';
import { extractHtmlAffiliations, extractPdfAffiliations } from './affiliations.mjs';
import { identifyUsedRobot, visualKeywords } from './visuals.mjs';

const normalize = value => value.replace(/\s+/g, ' ').trim();
const unavailable = reason => ({ status: 'unavailable', reason });
const userAgent = 'daily-paper/1.0 (personal robotics digest)';
const allowedOrigins = new Set(['https://arxiv.org', 'https://ar5iv.labs.arxiv.org', 'https://aclanthology.org',
  'https://raw.githubusercontent.com', 'https://robots.ros.org',
  'https://commons.wikimedia.org', 'https://upload.wikimedia.org']);
const publisherPages = { '1810.04805': 'https://aclanthology.org/N19-1423/' };
const diffusionRepository = 'columbia-ai-robotics/diffusion_policy';
const diffusionCommit = '5ba07ac6661db573af695b419a7947ecb704690f';
const scholarlyFigureGrant = 'Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.';
let nextRequestAt = 0;

export function reusableLicense(href) {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'creativecommons.org') return null;
    url.pathname = url.pathname.replace(/\/deed\.[A-Za-z-]+\/?$/, '/');
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
  const candidates = [];
  for (const figure of $('figure.ltx_figure').toArray()) {
    const caption = normalize($(figure).find('figcaption').text()).slice(0, 1500);
    const score = Number(/\b(?:overview|teaser|architecture|framework|pipeline|(?:experimental|physical|robot) (?:setup|platform|system))\b/i.test(caption)) * 3
      - Number(/\b(?:ablation|comparison|results|performance|training curve)\b/i.test(caption)) * 2;
    for (const image of $(figure).find('img[src]').toArray()) {
      const url = new URL($(image).attr('src'), htmlUrl);
      if (!['https://arxiv.org', 'https://ar5iv.labs.arxiv.org'].includes(url.origin)
        || url.origin !== new URL(htmlUrl).origin
        || !url.pathname.startsWith('/html/')
        || !/\.(png|jpe?g|webp)$/i.test(url.pathname)) continue;
      candidates.push({ url: url.href, caption, score });
    }
  }
  const selected = candidates.sort((a, b) => b.score - a.score)[0];
  return selected ? { url: selected.url, caption: selected.caption } : null;
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

export function projectDocumentationRights(readme, license) {
  if (!readme.includes('# Diffusion Policy') || !readme.includes('src="media/teaser.png"')
    || !readme.includes('https://diffusion-policy.cs.columbia.edu/')) {
    throw new Error('公式実装のREADMEで対象の解説図を確認できません。');
  }
  if (!license.startsWith('MIT License')
    || !license.includes('Copyright (c) 2023 Columbia Artificial Intelligence and Robotics Lab')
    || !license.includes('Permission is hereby granted')
    || !license.includes('associated documentation files')
    || !license.includes('The above copyright notice and this permission notice shall be included')
    || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    throw new Error('公式実装の資料を再利用できるMITライセンスを確認できません。');
  }
  return {
    kind: 'mit-documentation', notice: license,
    sourceUrl: `https://github.com/${diffusionRepository}/blob/${diffusionCommit}/LICENSE`,
  };
}

export function extractRobotPhotoSource(html) {
  const $ = load(html);
  if (!normalize($('footer').text()).includes('content on this site is licensed under')) return null;
  const licenseUrl = $('footer a[href]').toArray().map(a => reusableLicense($(a).attr('href'))).find(Boolean);
  const photo = $('img[src="/assets/img/robots/fetch/image.png"]');
  if (!licenseUrl || !photo.length) return null;
  return { licenseUrl, imageUrl: 'https://robots.ros.org/assets/img/robots/fetch/image.png' };
}

export function extractCommonsRobotPhoto(data) {
  const page = Object.values(data.query?.pages ?? {}).find(item => item.title === 'File:Unitree G1.jpg');
  const info = page?.imageinfo?.[0];
  if (!info || !/Unitree G1/i.test(load(info.extmetadata?.ImageDescription?.value ?? '').text())) return null;
  const licenseUrl = reusableLicense(info.extmetadata?.LicenseUrl?.value);
  const artist = normalize(load(info.extmetadata?.Artist?.value ?? '').text());
  if (!licenseUrl || !artist || info.extmetadata?.Restrictions?.value) return null;
  const image = new URL(info.url);
  const source = new URL(info.descriptionurl);
  if (image.origin !== 'https://upload.wikimedia.org' || !image.pathname.startsWith('/wikipedia/commons/')
    || source.origin !== 'https://commons.wikimedia.org' || !source.pathname.startsWith('/wiki/File:')) {
    throw new Error('ロボット参考写真の取得先・出典が許可されていません。');
  }
  image.search = '';
  return { imageUrl: image.href, sourceUrl: source.href, licenseUrl, credit: `${artist} · Wikimedia Commons` };
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
  const filename = `${paper.id.replaceAll('/', '_')}${preview.method === 'robot-photo' ? '-robot' : ''}.${preview.extension}`;
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
    credit: preview.credit ?? `${paper.authors.join(', ')} · arXiv:${paper.id}`,
  };
}

async function fetchProjectFigure(paper, root) {
  if (paper.id !== '2303.04137') return null;
  const base = `https://raw.githubusercontent.com/${diffusionRepository}/${diffusionCommit}`;
  const readme = await request(`${base}/README.md`);
  const license = await request(`${base}/LICENSE`);
  if (readme.error || license.error) {
    console.warn(`${paper.id}: 公式実装の資料・ライセンスを取得できません（${readme.error ?? license.error}）。`);
    return null;
  }
  const permission = projectDocumentationRights(readme.html, license.html);
  const image = await request(`${base}/media/teaser.png`, true);
  if (image.error) {
    console.warn(`${paper.id}: 公式実装の解説図を取得できません（${image.error}）。`);
    return null;
  }
  return savePreview(paper, root, {
    bytes: image.bytes, extension: imageExtension(image.bytes), method: 'project-figure',
    caption: 'Diffusion Policyの公式実装READMEに掲載された解説図。',
    sourceUrl: `https://github.com/${diffusionRepository}/blob/${diffusionCommit}/README.md`,
    originalUrl: `${base}/media/teaser.png`,
  }, { permission });
}

async function fetchRobotPhoto(paper, root, robot) {
  if (robot.name === 'Unitree G1') {
    const api = new URL('https://commons.wikimedia.org/w/api.php');
    api.search = new URLSearchParams({
      action: 'query', titles: 'File:Unitree G1.jpg', prop: 'imageinfo',
      iiprop: 'url|extmetadata', format: 'json',
    });
    const metadata = await request(api.href);
    if (metadata.error) {
      console.warn(`${paper.id}: G1参考写真の権利情報を取得できません（${metadata.error}）。`);
      return null;
    }
    const source = extractCommonsRobotPhoto(JSON.parse(metadata.html));
    if (!source) {
      console.warn(`${paper.id}: G1参考写真の機種・作者・再利用条件を確認できません。`);
      return null;
    }
    const image = await request(source.imageUrl, true);
    if (image.error) {
      console.warn(`${paper.id}: G1参考写真を取得できません（${image.error}）。`);
      return null;
    }
    return savePreview(paper, root, {
      bytes: image.bytes, extension: imageExtension(image.bytes), method: 'robot-photo',
      caption: '使用ロボットUnitree G1の参考写真（論文の実験写真ではありません）。',
      sourceUrl: source.sourceUrl, originalUrl: source.imageUrl, credit: source.credit,
    }, { licenseUrl: source.licenseUrl, licenseEvidenceUrl: source.sourceUrl });
  }
  if (robot.name !== 'Fetch') {
    console.warn(`${paper.id}: ${robot.name}の使用は確認できましたが、許可を確認した参考写真は未登録です。`);
    return null;
  }
  const sourceUrl = 'https://robots.ros.org/fetch/';
  const page = await request(sourceUrl);
  if (page.error) {
    console.warn(`${paper.id}: ロボット参考写真の出典を取得できません（${page.error}）。`);
    return null;
  }
  const source = extractRobotPhotoSource(page.html);
  if (!source) {
    console.warn(`${paper.id}: Fetch参考写真の再利用条件を確認できません。`);
    return null;
  }
  const image = await request(source.imageUrl, true);
  if (image.error) {
    console.warn(`${paper.id}: Fetch参考写真を取得できません（${image.error}）。`);
    return null;
  }
  return savePreview(paper, root, {
    bytes: image.bytes, extension: imageExtension(image.bytes), method: 'robot-photo',
    caption: '使用ロボットFetchの参考写真（論文の実験写真ではありません）。',
    sourceUrl, originalUrl: source.imageUrl, credit: 'ROS Robots · Fetch参考写真',
  }, { licenseUrl: source.licenseUrl, licenseEvidenceUrl: sourceUrl });
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
  let robotEvidence = paper.robotEvidence;
  let robotPhoto = paper.robotPhoto?.status === 'available' ? paper.robotPhoto : null;
  const apiInstitutions = [...new Set((paper.authorAffiliations ?? []).flatMap(author => author.institutions))];
  if (!affiliations && apiInstitutions.length) affiliations = {
    status: 'available', institutions: apiInstitutions, sourceUrl: paper.url, method: 'arxiv-api',
  };
  if (!figure) figure = await fetchProjectFigure(paper, root);
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
        if (!figure) {
          robotEvidence = identifyUsedRobot(await readPdfTextPages(pdf.bytes), paper.pdfUrl) ?? robotEvidence;
          if (robotEvidence && !robotPhoto) robotPhoto = await fetchRobotPhoto(paper, root, robotEvidence);
        }
      }
    }
  }
  if (preview) figure = await savePreview(paper, root, preview, { licenseUrl });
  return {
    figure: figure ?? unavailable('図の再利用条件を確認できないため、原論文をご覧ください。'),
    affiliations: affiliations ?? unavailable('論文から所属を確認できませんでした。'),
    ...(robotEvidence ? { robotEvidence } : {}), ...(robotPhoto ? { robotPhoto } : {}),
  };
}

export async function attachFigures(papers, root) {
  const enriched = [];
  for (const paper of papers) {
    if (paper.figure?.status === 'available' && paper.affiliations?.status === 'available') {
      enriched.push({ ...paper, visualKeywords: visualKeywords(paper) });
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
    if (assets.robotPhoto?.status === 'available') console.log(`${paper.id}: 使用ロボットの参考写真を保存しました。`);
    const enrichedPaper = { ...paper, ...assets };
    enriched.push({ ...enrichedPaper, visualKeywords: visualKeywords(enrichedPaper) });
  }
  return enriched;
}
