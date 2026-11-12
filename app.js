const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const state = { issues: [], date: '', topic: 'すべて', search: '', preview: params.get('preview') === '1' };

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function externalLink(label, url, license = false) {
  const link = element('a', '', label);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['arxiv.org', 'www.semanticscholar.org', ...(license ? ['creativecommons.org'] : [])].includes(parsed.hostname)) {
    throw new Error('出典リンクが許可されたHTTPS URLではありません。');
  }
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function detailUrl(paper) {
  const query = new URLSearchParams({ id: paper.id });
  if (state.preview) query.set('preview', '1');
  return `./paper.html?${query}`;
}

function tags(paper) {
  const container = element('div', 'paper-tags');
  container.append(...paper.topics.map(topic => element('span', 'tag', topic)));
  return container;
}

function metadata(paper, issue) {
  const container = element('div', 'paper-meta');
  container.append(
    element('span', '', paper.id),
    element('span', '', `公開 ${paper.published.slice(0, 10)}`),
    element('span', '', `掲載 ${issue.date}`),
  );
  if (paper.freshness === 'last-7-days') container.append(element('span', 'fallback-badge', '直近7日から補充'));
  if (paper.citations) {
    const citation = externalLink(`引用 ${paper.citations.count.toLocaleString('ja-JP')}`, paper.citations.url);
    citation.title = `Semantic Scholar · ${paper.citations.checkedAt.slice(0, 10)}確認。引用数は品質の保証ではありません。`;
    container.append(citation);
  }
  return container;
}

function affiliationLine(paper, detailed = false) {
  const container = element('p', 'affiliations');
  if (paper.affiliations?.status !== 'available') {
    container.textContent = '所属未確認';
    container.title = paper.affiliations?.reason ?? '論文記載の所属はまだ取得されていません。';
    return container;
  }
  const names = paper.affiliations.institutions;
  container.textContent = `所属：${names.join(' / ')}`;
  if (detailed) {
    container.append(document.createTextNode(' · '), externalLink('論文記載の出典', paper.affiliations.sourceUrl));
  }
  return container;
}

function figureImage(paper, lazy = true) {
  if (paper.figure?.status !== 'available') return null;
  if (!/^figures\/[A-Za-z0-9._-]+\.(png|jpg|webp)$/.test(paper.figure.src)) {
    throw new Error('図の保存先が不正です。');
  }
  const image = element('img');
  image.src = `./${paper.figure.src}`;
  image.alt = `${paper.title} — ${paper.figure.caption || '代表図'}`;
  image.loading = lazy ? 'lazy' : 'eager';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    const message = element('p', 'figure-error', '図を読み込めませんでした。原論文をご確認ください。');
    image.replaceWith(message);
    console.error(`図を読み込めません: ${paper.figure.src}`);
  }, { once: true });
  return image;
}

function paperCard(paper, issue) {
  const card = element('article', 'paper-card');
  const media = element('div', 'paper-media');
  const image = figureImage(paper);
  if (image) {
    const link = element('a');
    link.href = detailUrl(paper);
    link.setAttribute('aria-label', `${paper.headline ?? paper.title}のまとめを読む`);
    link.append(image);
    media.append(link);
  } else {
    media.classList.add('no-figure');
    media.title = paper.figure?.reason ?? '代表図はまだ取得されていません。';
    media.append(element('span', '', '図なし'), externalLink('原論文を見る ↗', paper.url));
  }
  const content = element('div', 'paper-content');
  const title = element(issue.groups ? 'h3' : 'h2');
  const titleLink = element('a', '', paper.headline ?? paper.title);
  titleLink.href = detailUrl(paper);
  title.append(titleLink);
  content.append(metadata(paper, issue), title);
  if (paper.headline) content.append(element('p', 'english-title', paper.title));
  content.append(
    element('p', 'card-summary', paper.summary ?? '選定プレビューです。日本語要約はまだ生成していません。'),
    element('p', 'authors', `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' ほか' : ''}`),
    affiliationLine(paper),
    tags(paper),
  );
  const links = element('div', 'paper-links');
  const read = element('a', '', 'まとめを読む →');
  read.href = detailUrl(paper);
  const original = externalLink('arXiv ↗', paper.url);
  original.className = 'secondary';
  links.append(read, original);
  content.append(links);
  card.append(media, content);
  return card;
}

function renderList() {
  const issues = state.issues.filter(issue => issue.date === state.date);
  const matches = issues.flatMap(issue => issue.papers
    .filter(paper => (state.topic === 'すべて' || paper.topics.includes(state.topic))
      && [paper.id, paper.title, paper.headline, paper.summary, paper.advantages, paper.method,
        paper.evaluation, paper.futureWork, ...paper.authors, ...paper.topics]
        .filter(Boolean).join(' ').toLowerCase().includes(state.search.toLowerCase()))
    .map(paper => ({ paper, issue })));
  $('#empty').hidden = state.issues.length > 0;
  $('#total-count').textContent = issues.reduce((sum, issue) => sum + issue.papers.length, 0);
  $('#paper-count').textContent = `${matches.length}件`;
  for (const button of $('#topics').children) {
    button.setAttribute('aria-pressed', String(button.textContent === state.topic));
  }
  $('#status').textContent = state.preview ? '選定プレビュー · 日本語要約は未生成'
    : state.issues.length ? `最新 ${state.issues[0].date} · 抄録に基づくAI要約` : '未掲載';
  if (state.issues.length && !matches.length) $('#status').textContent = '条件に一致する論文はありません。';
  const container = $('#papers');
  container.replaceChildren();
  for (const issue of issues) {
    if (!issue.groups) {
      const row = element('div', 'paper-row');
      row.append(...matches.filter(match => match.issue === issue).map(({ paper }) => paperCard(paper, issue)));
      container.append(row);
      continue;
    }
    for (const group of issue.groups) {
      const section = element('section', 'paper-group');
      section.dataset.groupId = group.id;
      const chosen = matches.filter(match => match.issue === issue && match.paper.groupId === group.id);
      const heading = element('div', 'group-heading');
      heading.append(element('h2', '', group.title), element('span', '', `${chosen.length} / 3`));
      section.append(heading);
      if (group.warnings.length) section.append(element('p', 'group-note', group.warnings.join(' ')));
      const row = element('div', 'paper-row');
      row.append(...chosen.map(({ paper }) => paperCard(paper, issue)));
      if (state.topic === 'すべて' && !state.search) {
        for (let index = chosen.length; index < 3; index++) {
          row.append(element('div', 'paper-slot', '条件に一致する未掲載論文がありません'));
        }
      }
      section.append(row);
      container.append(section);
    }
  }
}

function detailSection(title, content) {
  const section = element('section', 'detail-section');
  section.append(element('h2', '', title), content);
  return section;
}

function renderDetail() {
  const issue = state.issues.find(item => item.papers.some(paper => paper.id === params.get('id')));
  const paper = issue?.papers.find(item => item.id === params.get('id'));
  if (!paper) throw new Error('指定された論文が見つかりません。一覧から選び直してください。');
  const container = $('#paper-detail');
  document.title = `${paper.headline ?? paper.title} — Physical AI Daily`;
  $('#back-link').href = state.preview ? './?preview=1' : './';
  $('#status').textContent = state.preview ? '選定プレビュー · 日本語要約は未生成' : '抄録に基づくAI要約';
  container.append(metadata(paper, issue), element('h1', 'detail-title', paper.headline ?? paper.title));
  if (paper.headline) container.append(element('p', 'english-title', paper.title));
  container.append(element('p', 'authors', paper.authors.join(', ')), affiliationLine(paper, true), tags(paper));
  const links = element('div', 'paper-links');
  links.append(externalLink('arXiv ↗', paper.url), externalLink('PDF ↗', paper.pdfUrl));
  container.append(links);
  const image = figureImage(paper, false);
  if (image) {
    const figure = element('figure', 'paper-figure');
    const caption = element('figcaption', '', paper.figure.caption);
    const credit = element('span', 'figure-credit', `${paper.figure.credit} · `);
    credit.append(externalLink('出典', paper.figure.sourceUrl), document.createTextNode(' · '),
      externalLink(paper.figure.licenseUrl.includes('/zero/') ? 'CC0' : paper.figure.licenseUrl.includes('/by-sa/') ? 'CC BY-SA' : 'CC BY', paper.figure.licenseUrl, true));
    caption.append(credit);
    figure.append(image, caption);
    container.append(figure);
  }
  container.append(detailSection('要約', element('p', 'summary',
    paper.summary ?? '日本語要約はまだ生成していません。以下の原文抄録をご確認ください。')));
  if (paper.advantages && paper.method && paper.evaluation && paper.futureWork) {
    for (const [key, title] of [
      ['advantages', '優位点・独自点'], ['method', '技術や手法のキモ'],
      ['evaluation', '検証方法'], ['futureWork', '今後の課題'],
    ]) container.append(detailSection(title, element('p', 'detail-text', paper[key])));
  } else if (paper.takeaways) {
    const points = element('ul', 'takeaways');
    points.append(...paper.takeaways.map(point => element('li', '', point)));
    container.append(
      detailSection('要点', points),
      detailSection('研究との関連', element('p', 'relevance', paper.relevance)),
      detailSection('未確認事項', element('p', 'caveat', paper.caveat)),
    );
  }
  const abstract = element('details');
  abstract.open = state.preview;
  abstract.append(element('summary', '', '原文の抄録'), element('p', 'abstract', paper.abstract));
  container.append(abstract);
}

async function init() {
  const response = await fetch(state.preview ? './data/preview.json' : './data/archive.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(state.preview && response.status === 404
      ? 'プレビューがありません。npm run preview を実行してください。'
      : `論文データを読み込めませんでした（HTTP ${response.status}）。`);
  }
  const data = await response.json();
  if (data.version !== 1 || !Array.isArray(data.issues)) throw new Error('論文データの形式が不正です。');
  state.issues = data.issues;
  state.date = state.issues[0]?.date ?? '';
  if (document.body.dataset.page === 'paper') {
    renderDetail();
    return;
  }
  const topicLabels = ['すべて', ...new Set(state.issues.flatMap(issue => issue.papers.flatMap(paper => paper.topics)))];
  for (const label of topicLabels) {
    const button = element('button', '', label);
    button.type = 'button';
    button.addEventListener('click', () => { state.topic = label; renderList(); });
    $('#topics').append(button);
  }
  $('#search').addEventListener('input', event => { state.search = event.target.value; renderList(); });
  $('#issue-select').addEventListener('change', event => { state.date = event.target.value; renderList(); });
  $('#issue-select').replaceChildren(...state.issues.map(issue => {
    const option = element('option', '', issue.date);
    option.value = issue.date;
    return option;
  }));
  renderList();
}

init().catch(error => {
  ($('#papers') ?? $('#paper-detail')).replaceChildren();
  $('#status').classList.add('error');
  $('#status').textContent = error.message;
});
