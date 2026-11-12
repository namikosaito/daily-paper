import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dayInTimezone, hasCurrentSummary, makePrompt, parseCopilotEvents, parseSummaries,
  selectDailyGroups, validateArchive, validateConfig,
} from '../src/digest.mjs';
import { attachFigures } from '../src/figures.mjs';
import { fetchDailyCandidates } from '../src/sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const preview = process.argv.includes('--preview');
const figuresOnly = process.argv.includes('--figures');
const refresh = process.argv.includes('--refresh');
const checkCopilot = process.argv.includes('--check-copilot');
const unknown = process.argv.slice(2).filter(arg => !['--preview', '--figures', '--refresh', '--check-copilot'].includes(arg));
if (unknown.length) throw new Error(`不明な引数です: ${unknown.join(' ')}`);
if ([preview, figuresOnly, refresh, checkCopilot].filter(Boolean).length > 1) {
  throw new Error('--preview、--figures、--refresh、--check-copilot は同時に使用できません。');
}

async function atomicJson(filename, data) {
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function summarize(papers) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'daily-paper-'));
  try {
    const executable = path.join(root, 'node_modules/.bin/copilot');
    const { stdout } = await run(executable, [
      '-p', makePrompt(papers), '--silent', '--output-format', 'json', '--stream', 'off',
      '--available-tools',
      '--deny-tool', 'shell', '--deny-tool', 'write', '--deny-tool', 'read',
      '--deny-tool', 'url', '--deny-tool', 'memory', '--disable-builtin-mcps',
      '--no-custom-instructions', '--no-ask-user', '--no-auto-update', '--no-color',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024,
    });
    try {
      return parseSummaries(parseCopilotEvents(stdout), papers);
    } catch (error) {
      const diagnosticPath = path.join(root, '.run/last-copilot-response.txt');
      await writeFile(diagnosticPath, stdout, { mode: 0o600 });
      throw new Error(`${error.message}\n確認用の応答: ${diagnosticPath}`, { cause: error });
    }
  } catch (error) {
    throw new Error(
      'Copilot 要約に失敗しました。npm exec -- copilot login で認証・利用枠を確認してください。'
      + `\n${error.stderr?.trim() || error.message}`,
      { cause: error },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function summarizeBatches(papers) {
  const summarized = [];
  for (let offset = 0; offset < papers.length; offset += 3) {
    summarized.push(...await summarize(papers.slice(offset, offset + 3)));
  }
  return summarized;
}

async function main() {
  const config = validateConfig(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')));
  const archivePath = path.join(root, 'data/archive.json');
  const archive = validateArchive(JSON.parse(await readFile(archivePath, 'utf8')));
  if (checkCopilot) {
    const sample = archive.issues[0]?.papers[0];
    if (!sample) throw new Error('認証確認に使用できる掲載済み論文がありません。');
    await summarize([sample]);
    console.log('Copilotの実リクエストと日本語要約の検証に成功しました。アーカイブは変更しません。');
    return;
  }
  if (figuresOnly) {
    for (const issue of archive.issues) issue.papers = await attachFigures(issue.papers, root);
    await atomicJson(archivePath, archive);
    console.log('掲載済み論文の図・ロボット参考写真・キーワードを更新しました。Copilotリクエストは行いません。');
    return;
  }
  const now = new Date();
  const date = dayInTimezone(now, config.timezone);
  const existing = archive.issues.find(issue => issue.date === date);
  if (!preview && !refresh && existing) {
    const outdated = existing.papers.filter(paper => !hasCurrentSummary(paper));
    if (!outdated.length) {
      console.log(`${date} 号は発行済みです。追加のCopilotリクエストは行いません。`);
      return;
    }
    const rewritten = new Map((await summarizeBatches(outdated)).map(paper => [paper.id, paper]));
    existing.papers = existing.papers.map(paper => rewritten.get(paper.id) ?? paper);
    existing.generatedAt = now.toISOString();
    validateArchive(archive);
    await atomicJson(archivePath, archive);
    console.log(`${date} 号の${outdated.length}件を5項目の要約へ更新しました。選定・図・所属は保持します。`);
    return;
  }
  const selectionArchive = refresh
    ? { ...archive, issues: archive.issues.filter(issue => issue.date !== date) } : archive;
  const { groups, papers } = selectDailyGroups(await fetchDailyCandidates(config, now), selectionArchive, config, now);
  for (const group of groups) for (const warning of group.warnings) console.warn(`${group.title}: ${warning}`);
  if (!papers.length) throw new Error('条件に一致する論文がありません。既存の掲載内容を保持します。');
  console.log(`選定した論文:\n${papers.map(paper => `- ${paper.id}: ${paper.title}`).join('\n')}`);
  let contentPapers = papers;
  if (!preview) {
    const previous = refresh ? archive.issues.find(item => item.date === date)?.papers ?? [] : [];
    const cached = new Map(previous.filter(hasCurrentSummary).map(paper => [paper.id, paper]));
    const missing = papers.filter(paper => !cached.has(paper.id));
    for (const paper of await summarizeBatches(missing)) cached.set(paper.id, paper);
    contentPapers = papers.map(paper => ({ ...cached.get(paper.id), ...paper }));
  }
  const issue = {
    date, generatedAt: now.toISOString(), title: config.title, timezone: config.timezone,
    source: 'arXiv abstract', preview, groups,
    papers: await attachFigures(contentPapers, root),
  };
  if (preview) {
    await atomicJson(path.join(root, 'data/preview.json'), { version: 1, issues: [issue] });
    console.log('要約なしプレビューを保存しました。http://localhost:4173/?preview=1');
  } else {
    if (refresh) archive.issues = archive.issues.filter(item => item.date !== date);
    archive.issues.unshift(issue);
    archive.issues.sort((a, b) => b.date.localeCompare(a.date));
    validateArchive(archive);
    await atomicJson(archivePath, archive);
    console.log(`${date} 号を発行しました（5カテゴリ・日本語要約付き${papers.length}件）。`);
  }
}

await mkdir(path.join(root, '.run'), { recursive: true });
const lock = path.join(root, '.run/digest.lock');
try {
  await mkdir(lock);
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('別の発行処理が実行中です。異常終了後なら .run/digest.lock を確認してください。');
    process.exit(1);
  }
  throw error;
}
try {
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await rm(lock, { recursive: true, force: true });
}
