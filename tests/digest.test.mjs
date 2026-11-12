import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildQueryUrl, dayInTimezone, parseCopilotEvents, parseFeed, parseSummaries,
  GROUPS, hasCurrentSummary, scorePaper, selectDailyGroups, validateArchive, validateConfig, makePrompt,
} from '../src/digest.mjs';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-12T21:00:00Z');
const empty = { version: 1, issues: [] };
const paper = (id, extra = {}) => ({
  id, title: 'Vision-language-action robot policy with sim-to-real reinforcement learning',
  abstract: 'A robot foundation model for embodied manipulation.',
  authors: ['Example Author'], published: '2026-11-11T12:00:00Z', updated: '2026-11-11T12:00:00Z',
  categories: ['cs.RO'], url: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`,
  ...extra,
});
const papers = Array.from({ length: 5 }, (_, i) => paper(`2611.${10000 + i}`));
const summary = id => ({
  id, headline: 'ロボットの新しい学習方法',
  summary: 'ロボットによる物体操作のための新しい方策学習手法を提案しています。arXivの概要を根拠に研究の狙いと結果をまとめています。',
  advantages: '従来の手法との違いを説明します。比較実験の条件はarXivの概要だけでは確認できません。',
  method: '画像などの観測を入力にして、ロボットの動作を出力する方策を学習します。',
  evaluation: '評価対象や比較条件の詳細はarXivの概要だけでは確認できません。',
  futureWork: 'arXivの概要には今後の課題の記載がありません。実機での詳細な評価は本文の確認が必要です。',
});

test('JST date changes at UTC 15:00, independent of host timezone', () => {
  assert.equal(dayInTimezone(new Date('2026-11-12T14:59:59Z')), '2026-11-12');
  assert.equal(dayInTimezone(new Date('2026-11-12T15:00:00Z')), '2026-11-13');
});

test('config enforces fifteen papers, seven-day fallback, citation bounds and valid topics', () => {
  assert.equal(validateConfig(config), config);
  assert.equal(config.minimumCitations, 30);
  for (const change of [
    { papersPerDay: 5 }, { maxCandidates: 0 }, { lookbackDays: 30 }, { minimumCitations: 29 },
    { topics: [] }, { timezone: 'invalid' }, { timezone: undefined },
    { topics: [{ label: 'RL', terms: [''], weight: 1 }] },
  ]) assert.throws(() => validateConfig({ ...config, ...change }));
});

test('query encodes search and a bounded publication window', () => {
  const url = buildQueryUrl(config, now);
  assert.equal(url.origin, 'https://export.arxiv.org');
  assert.equal(url.searchParams.get('max_results'), '300');
  assert.match(url.searchParams.get('search_query'), /submittedDate:\[202611052100 TO 202611122100\]/);
  assert.equal(url.searchParams.get('sortBy'), 'submittedDate');
});

test('Atom parsing decodes entities, preserves multiple authors, strips versions, and uses HTTPS', () => {
  const entries = [1, 2].map(i => `<entry><id>http://arxiv.org/abs/2611.1000${i}v2</id>
    <title>Robot &amp; learning</title><summary>Some
    robot research.</summary><published>2026-11-11T00:00:00Z</published>
    <updated>2026-11-12T00:00:00Z</updated><author><name>A</name></author>
    <author><name>B</name></author><category term="cs.RO"/><category term="cs.LG"/></entry>`).join('');
  const parsed = parseFeed(`<feed>${entries}</feed>`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, '2611.10001');
  assert.equal(parsed[0].title, 'Robot & learning');
  assert.equal(parsed[0].abstract, 'Some robot research.');
  assert.deepEqual(parsed[0].authors, ['A', 'B']);
  assert.deepEqual(parsed[0].categories, ['cs.RO', 'cs.LG']);
  assert.equal(parsed[0].pdfUrl, 'https://arxiv.org/pdf/2611.10001');
  assert.equal(parseFeed('<feed/>').length, 0);
});

test('malformed XML, arXiv API error entries, and missing metadata fail explicitly', () => {
  for (const xml of [
    '<feed><entry></feed>', '<html/>',
    '<feed><entry><id>https://arxiv.org/api/errors</id><title>Error</title></entry></feed>',
    '<feed><entry><id>https://arxiv.org/abs/2611.10001v1</id></entry></feed>',
  ]) assert.throws(() => parseFeed(xml));
});

test('short acronym RL/VLA cannot match arbitrary substrings', () => {
  const scored = scorePaper(paper('robot', {
    title: 'Robot motion planning', abstract: 'Overlap and overlay analysis.',
  }), config);
  assert.deepEqual(scored.topics, ['Robotics']);
});

test('research-specific manipulation papers outrank generic robotics and inference infrastructure', () => {
  const candidates = [
    paper('infrastructure', { title: 'Edge inference for embodied robot world models', abstract: 'Scheduling compute for robot foundation models.' }),
    paper('locomotion', { title: 'Humanoid robot locomotion', abstract: 'A new walking controller.' }),
    paper('residual', { title: 'Object-centric residual RL for sim-to-real VLA manipulation', abstract: 'Residual reinforcement learning improves vision-language-action policies on real robots.' }),
    paper('touch', { title: 'Cross-modal tactile and visual learning for contact-rich manipulation', abstract: 'Haptic representation and force feedback for deformable objects.' }),
    paper('tools', { title: 'Subgoal prediction for long-horizon tool-use manipulation', abstract: 'Multimodal predictive learning for wiping and pouring with robots.' }),
  ];
  const selected = candidates.map(item => scorePaper(item, config)).sort((a, b) => b.personalScore - a.personalScore);
  assert.deepEqual(new Set(selected.slice(0, 3).map(item => item.id)), new Set(['residual', 'touch', 'tools']));
  assert.equal(selected[4].id, 'locomotion');
});

function fixturePools() {
  return Object.fromEntries(GROUPS.map((group, groupIndex) => [group.id, Array.from({ length: 3 }, (_, i) =>
    paper(`${group.kind === 'recent' ? '2611' : '1801'}.${20000 + groupIndex * 10 + i}`, {
      ...(group.scope === 'ai' ? {
        title: `Computer vision model ${i}`, abstract: 'Learning a visual representation.', categories: ['cs.CV'],
      } : group.scope === 'robotics' ? {
        title: `Robot motion planning ${i}`, abstract: 'Sampling-based navigation and control.',
      } : {}),
      published: group.kind === 'recent' ? '2026-11-12T12:00:00Z' : '2018-01-02T00:00:00Z',
      ...(group.kind === 'classic' ? { citations: {
        count: 10000 - i, source: 'Semantic Scholar', checkedAt: now.toISOString(),
        url: `https://www.semanticscholar.org/paper/${'a'.repeat(40)}`,
      } } : {}),
    }))]));
}

test('five ordered groups contain exactly three unique arXiv papers each', () => {
  const result = selectDailyGroups(fixturePools(), empty, config, now);
  assert.equal(result.groups.length, 5);
  assert.equal(result.papers.length, 15);
  assert.equal(new Set(result.papers.map(item => item.id)).size, 15);
  assert.deepEqual(result.groups.map(group => group.id), GROUPS.map(group => group.id));
  assert.ok(result.groups.every(group => group.paperIds.length === 3));
});

test('yesterday/today JST takes priority over a more relevant seven-day fallback', () => {
  const pools = fixturePools();
  pools['recent-personal'].push(paper('2611.99991', {
    published: '2026-11-10T12:00:00Z',
    abstract: 'Residual RL, tactile force control, deformable objects, tool use, subgoal prediction and sim-to-real.',
  }));
  const result = selectDailyGroups(pools, empty, config, now);
  assert.ok(!result.groups[0].paperIds.includes('2611.99991'));
  pools['recent-personal'] = pools['recent-personal'].slice(0, 2).concat(pools['recent-personal'].at(-1));
  const fallback = selectDailyGroups(pools, empty, config, now);
  assert.equal(fallback.papers.find(item => item.id === '2611.99991').freshness, 'last-7-days');
  assert.equal(fallback.groups[0].warnings.length, 1);
});

test('latest window uses original publication date, excludes future/older papers, and never invents missing slots', () => {
  const pools = fixturePools();
  pools['recent-personal'] = [
    paper('old', { published: '2026-11-06T14:59:59Z', updated: now.toISOString() }),
    paper('future', { published: '2026-11-14T00:00:00Z' }),
    paper('valid', { published: '2026-11-12T12:00:00Z' }),
    paper('valid', { published: '2026-11-12T12:00:00Z' }),
  ];
  const result = selectDailyGroups(pools, empty, config, now);
  assert.deepEqual(result.groups[0].paperIds, ['valid']);
  assert.match(result.groups[0].warnings.join(' '), /1\/3/);
});

test('high-citation pools are year-independent, use real counts, and exclude irrelevant infrastructure', () => {
  const pools = fixturePools();
  const high = pools['classic-robotics'][0];
  pools['classic-robotics'].push(paper('tensorflow', {
    title: 'TensorFlow: Large-scale machine learning systems', abstract: 'Applications include robotics and science.',
    categories: ['cs.LG'], published: '2016-01-01T00:00:00Z',
    citations: { ...high.citations, count: 1000000 },
  }));
  pools['classic-ai'].push({ ...pools['classic-ai'][0], id: 'low', citations: { ...high.citations, count: 29 } });
  const result = selectDailyGroups(pools, empty, config, now);
  assert.ok(!result.papers.some(item => ['tensorflow', 'low'].includes(item.id)));
  assert.ok(result.papers.some(item => item.published.startsWith('2018')));
  const classics = result.papers.filter(item => item.groupId === 'classic-ai');
  assert.ok(classics[0].citations.count >= classics[1].citations.count);
});

test('papers cannot repeat across groups or past editions', () => {
  const pools = fixturePools();
  pools['classic-robotics'].unshift(pools['classic-personal'][0]);
  const archived = { version: 1, issues: [{ papers: [pools['recent-personal'][0]] }] };
  const result = selectDailyGroups(pools, archived, config, now);
  assert.equal(new Set(result.papers.map(item => item.id)).size, result.papers.length);
  assert.ok(!result.papers.some(item => item.id === pools['recent-personal'][0].id));
});

test('all three classic categories include 30 citations, exclude 29, and retain citation ordering', () => {
  const pools = fixturePools();
  const classics = GROUPS.filter(group => group.kind === 'classic');
  for (const [index, group] of classics.entries()) {
    const source = pools[group.id][0];
    pools[group.id] = [29, 30, 31].map(count => ({
      ...source, id: `1801.${30000 + index * 100 + count}`,
      citations: { ...source.citations, count },
    }));
  }
  const result = selectDailyGroups(pools, empty, config, now);
  for (const group of classics) {
    const selected = result.papers.filter(paper => paper.groupId === group.id);
    assert.deepEqual(selected.map(paper => paper.citations.count), [31, 30]);
  }
});

test('new grouped editions validate while legacy five-paper editions remain readable', () => {
  const selected = selectDailyGroups(fixturePools(), empty, config, now);
  const issue = { date: '2026-11-13', ...selected, papers: selected.papers.map(item => ({ ...item, ...summary(item.id) })) };
  assert.equal(validateArchive({ version: 1, issues: [issue] }).issues[0].papers.length, 15);
  assert.throws(() => validateArchive({ version: 1, issues: [{ ...issue, papers: issue.papers.slice(0, 14) }] }));
  const wrongGroups = structuredClone(issue);
  wrongGroups.groups[1].paperIds[0] = wrongGroups.groups[0].paperIds[0];
  assert.throws(() => validateArchive({ version: 1, issues: [wrongGroups] }));
});
test('Copilot output is matched by ID, never by order, and cannot replace source URLs', () => {
  const results = papers.map(item => ({ ...summary(item.id), url: 'https://malicious.invalid/' })).reverse();
  const parsed = parseSummaries(JSON.stringify({ papers: results }), papers);
  assert.deepEqual(parsed.map(item => item.id), papers.map(item => item.id));
  assert.ok(parsed.every(item => item.url.startsWith('https://arxiv.org/')));
  assert.equal(parseSummaries(`\`\`\`json\n${JSON.stringify({ papers: results })}\n\`\`\``, papers).length, 5);
  assert.ok(parsed.every(hasCurrentSummary));
  const legacy = { ...papers[0], takeaways: ['以前の要点'], relevance: '以前の関連', caveat: '以前の注記' };
  const rewritten = parseSummaries(JSON.stringify({ papers: [summary(legacy.id)] }), [legacy])[0];
  assert.ok(!['takeaways', 'relevance', 'caveat'].some(key => key in rewritten));
});

test('Copilot JSONL preserves raw Japanese strings without terminal line-wrapping', () => {
  const content = JSON.stringify({ papers: papers.map(item => summary(item.id)) });
  const events = [
    { type: 'session.start', data: {} },
    { type: 'assistant.message', data: { content } },
    { type: 'result', exitCode: 0 },
  ].map(event => JSON.stringify(event)).join('\n');
  assert.equal(parseCopilotEvents(events), content);
  assert.equal(parseSummaries(parseCopilotEvents(events), papers).length, 5);
  for (const invalid of [
    '', 'not json', JSON.stringify({ type: 'result', exitCode: 0 }),
    events.replace('"exitCode":0', '"exitCode":1'),
    `${events}\n${JSON.stringify({ type: 'session.error', data: { message: 'Authentication failed' } })}`,
  ]) assert.throws(() => parseCopilotEvents(invalid));
});

test('generated summaries consistently call the source arXiv without changing original metadata', () => {
  const entry = { ...summary(papers[0].id), evaluation: '\u6284\u9332には評価条件の記載がありません。' };
  assert.equal(hasCurrentSummary(entry), false);
  const result = parseSummaries(JSON.stringify({ papers: [entry] }), [papers[0]])[0];
  assert.equal(result.evaluation, 'arXivの概要には評価条件の記載がありません。');
  assert.equal(result.abstract, papers[0].abstract);
  assert.equal(hasCurrentSummary(result), true);
});

test('invalid count, duplicate IDs, wrong IDs, incomplete/non-Japanese summaries fail', () => {
  const good = papers.map(item => summary(item.id));
  for (const invalid of [
    'not JSON', 'null', '{}', JSON.stringify({ papers: good.slice(0, 4) }),
    JSON.stringify({ papers: [good[0], ...good.slice(0, 4)] }),
    JSON.stringify({ papers: [{ ...good[0], id: 'unknown' }, ...good.slice(1)] }),
    JSON.stringify({ papers: [{ ...good[0], headline: 'English only' }, ...good.slice(1)] }),
    ...['advantages', 'method', 'evaluation', 'futureWork'].map(key =>
      JSON.stringify({ papers: [{ ...good[0], [key]: undefined }, ...good.slice(1)] })),
    JSON.stringify({ papers: [null, ...good.slice(1)] }),
    JSON.stringify({ papers: [{ ...good[0], summary: '要'.repeat(241) }, ...good.slice(1)] }),
    JSON.stringify({ papers: [{ ...good[0], headline: '題'.repeat(81) }, ...good.slice(1)] }),
  ]) assert.throws(() => parseSummaries(invalid, papers));
});

test('archive validation rejects duplicate dates, duplicate paper IDs, or partial editions', () => {
  const issue = { date: '2026-11-13', papers: papers.map(item => ({ ...item, ...summary(item.id) })) };
  assert.equal(validateArchive(empty), empty);
  assert.equal(validateArchive({ version: 1, issues: [issue] }).issues.length, 1);
  for (const issues of [
    [issue, issue], [{ ...issue, papers: issue.papers.slice(0, 4) }],
    [issue, { ...issue, date: '2026-11-14' }],
  ]) assert.throws(() => validateArchive({ version: 1, issues }));
});

test('prompt delimits external metadata, forbids tools and full-text claims', () => {
  const prompt = makePrompt(papers);
  assert.match(prompt, /<untrusted_paper_metadata>/);
  assert.match(prompt, /外部ツール、ファイル、ウェブ検索は使わない/);
  assert.match(prompt, /本文を読んだふりをしない/);
  assert.match(makePrompt([papers[0]]), /入力と同じ1件/);
  for (const label of ['要約', '優位点・独自点', '技術や手法のキモ', '検証方法', '今後の課題']) {
    assert.ok(prompt.includes(label));
  }
  assert.match(prompt, /専門用語や略語は初出で簡潔に言い換え/);
  assert.match(prompt, /実機実験やベンチマークの実施を推測しない/);
  assert.match(prompt, /arXivの概要には今後の課題の記載がありません/);
});

test('legacy summaries remain readable but cannot be reused as the current five-section format', () => {
  const legacy = { ...papers[0], headline: '以前の日本語見出し', summary: '以前の日本語要約です。',
    takeaways: ['以前の要点'], relevance: '研究との関連です', caveat: '以前の未確認事項です' };
  assert.equal(hasCurrentSummary(legacy), false);
  const issue = { date: '2026-11-13', papers: papers.map(item => ({ ...legacy, id: item.id })) };
  assert.equal(validateArchive({ version: 1, issues: [issue] }).issues[0].papers.length, 5);
  const partial = { ...legacy, advantages: '新しい優位点の説明です' };
  assert.throws(() => validateArchive({ version: 1, issues: [{ ...issue, papers: [partial, ...issue.papers.slice(1)] }] }));
});
