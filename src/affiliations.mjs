import { load } from 'cheerio';

const clean = value => value.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]+/g, '')
  .replace(/(?:email|e-mail)\s*:\s*/gi, '').replace(/\s+/g, ' ').trim();

export function extractHtmlAffiliations(html) {
  const $ = load(html);
  const institutions = [];
  for (const node of $('.ltx_role_affiliation, [itemprop="affiliation"]').toArray()) {
    const text = $(node).text().replace(/https?:\/\/\S+/gi, '')
      .replace(/^[†‡\s]*(?:affiliation\s*:\s*)/i, '');
    for (const part of text.split(/\\affilnum\s*[\d*,]+/)) {
      const name = clean(part).replace(/^[\d*†‡,\s]+/, '').replace(/[.;/|]+$/, '').trim();
      if (name.length >= 4 && name.length <= 350 && !/^(?:joint first author|equal contribution|corresponding author)$/i.test(name)) institutions.push(name);
    }
  }
  return [...new Set(institutions)];
}

export function extractPdfAffiliations(lines) {
  const institutions = [];
  const start = /^(?:(?:Department|School|Faculty|Institute|Laborator(?:y|ies)|Center|Centre)\b|(?:Microsoft|Google|DeepMind|OpenAI|Meta|NVIDIA|Amazon|Toyota|RIKEN|ETH|EPFL|MIT|KAIST|CMU)\b|(?:\p{Lu}[\p{L}.&'-]*\s+(?:(?:of|and|the)\s+)?){0,7}(?:University|Institute|College|Research)\b)/u;
  for (const line of lines) {
    const name = clean(line).replace(/^[\d*†‡,\s]+/, '');
    if (name.length < 4 || name.length > 250 || !start.test(name)) continue;
    if (/\b(?:we|our|propose|proposed|model|trained|training|https?|copyright|funded|supported)\b/i.test(name)) continue;
    institutions.push(name.replace(/[.;]+$/, ''));
  }
  return [...new Set(institutions)];
}
