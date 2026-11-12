import { buildQueryUrl, parseFeed } from './digest.mjs';

const citationQueries = {
  'classic-personal': '(robot | robotic | robotics) + (learning | imitation | reinforcement | neural) + (manipulation | tactile | haptic | grasping | "sim-to-real" | "vision-language-action" | demonstration)',
  'classic-robotics': 'robot | robotic | robotics | SLAM | "simultaneous localization and mapping"',
  'classic-ai': '"machine learning" | "deep learning" | "computer vision" | "artificial intelligence" | transformer | "neural network"',
};
let nextArxivRequest = 0;
let nextCitationRequest = 0;

async function request(url, source) {
  const next = source === 'arXiv' ? nextArxivRequest : nextCitationRequest;
  if (next > Date.now()) await new Promise(resolve => setTimeout(resolve, next - Date.now()));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (source === 'arXiv') nextArxivRequest = Date.now() + 3100;
    else nextCitationRequest = Date.now() + 3100;
    const headers = { 'User-Agent': 'daily-paper/1.0 (academic paper digest)' };
    if (source === 'Semantic Scholar' && process.env.SEMANTIC_SCHOLAR_API_KEY) {
      headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers });
    if (response.ok) return response;
    await response.body?.cancel();
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 90) : 10 * (attempt + 1);
      console.warn(`${source} HTTP ${response.status}: ${seconds}秒後に再試行します。`);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      continue;
    }
    throw new Error(`${source} HTTP ${response.status}。データ取得に失敗したため、既存の掲載内容を保持します。`);
  }
}

export function citationRecords(data, limit, checkedAt) {
  if (!Array.isArray(data?.data)) throw new Error('Semantic Scholarの応答形式が不正です。');
  const records = new Map();
  for (const item of data.data) {
    const id = item.externalIds?.ArXiv?.replace(/^arxiv:/i, '').replace(/v\d+$/, '');
    if (!id || !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/.test(id)
      || !Number.isInteger(item.citationCount) || item.citationCount < 0
      || !/^[a-f0-9]{40}$/.test(item.paperId ?? '')) continue;
    const record = {
      id,
      citations: {
        count: item.citationCount, source: 'Semantic Scholar', checkedAt,
        url: `https://www.semanticscholar.org/paper/${item.paperId}`,
      },
    };
    if (!records.has(id) || records.get(id).citations.count < item.citationCount) records.set(id, record);
  }
  return [...records.values()].sort((a, b) => b.citations.count - a.citations.count || a.id.localeCompare(b.id)).slice(0, limit);
}

export async function fetchDailyCandidates(config, now = new Date()) {
  const pools = {};
  for (const [id, query] of [['recent-personal', config.query], ['recent-ai', config.aiQuery]]) {
    const response = await request(buildQueryUrl({ ...config, query }, now), 'arXiv');
    pools[id] = parseFeed(await response.text());
    console.log(`${id}: arXiv候補 ${pools[id].length}件`);
  }
  const recordsByGroup = {};
  for (const [id, query] of Object.entries(citationQueries)) {
    const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search/bulk');
    url.search = new URLSearchParams({
      query, sort: 'citationCount:desc', fields: 'title,externalIds,citationCount,year',
    }).toString();
    const response = await request(url, 'Semantic Scholar');
    recordsByGroup[id] = citationRecords(await response.json(), config.classicCandidatesPerCategory, new Date().toISOString());
    if (!recordsByGroup[id].length) throw new Error(`${id}: arXiv ID付きの引用数データを取得できませんでした。`);
    console.log(`${id}: 引用数確認済み候補 ${recordsByGroup[id].length}件`);
  }
  const ids = [...new Set(Object.values(recordsByGroup).flatMap(records => records.map(record => record.id)))];
  const arxivPapers = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const url = new URL('https://export.arxiv.org/api/query');
    url.search = new URLSearchParams({ id_list: ids.slice(offset, offset + 100).join(','), max_results: '100' }).toString();
    const response = await request(url, 'arXiv');
    for (const paper of parseFeed(await response.text())) arxivPapers.set(paper.id, paper);
  }
  for (const [id, records] of Object.entries(recordsByGroup)) {
    pools[id] = [];
    for (const record of records) {
      const paper = arxivPapers.get(record.id);
      if (paper) pools[id].push({ ...paper, citations: record.citations });
      else console.warn(`${id}: arXivで本文メタデータを確認できないため除外: ${record.id}`);
    }
  }
  return pools;
}
