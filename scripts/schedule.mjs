import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayInTimezone, validateArchive } from '../src/digest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const label = 'local.daily-paper.digest';
const agent = path.join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const action = process.argv[2];
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

async function installed() {
  try {
    await run('/bin/launchctl', ['print', service]);
    return true;
  } catch (error) {
    if (error.stderr?.includes('Could not find service')) return false;
    throw error;
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('この自動実行設定はmacOS専用です。');
  if (action === 'run') {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23',
    }).format(now));
    if (hour < 6) return;
    const archive = validateArchive(JSON.parse(await readFile(path.join(root, 'data/archive.json'), 'utf8')));
    if (archive.issues.some(issue => issue.date === dayInTimezone(now))) return;
    try {
      const { stdout, stderr } = await run(process.execPath, [path.join(root, 'scripts/digest.mjs')], {
        cwd: root, timeout: 2700000, maxBuffer: 3 * 1024 * 1024,
      });
      if (stdout) console.log(stdout.trim());
      if (stderr) console.error(stderr.trim());
    } catch (error) {
      throw new Error(`自動発行に失敗しました: ${error.stderr?.trim() || error.message}`, { cause: error });
    }
    return;
  }
  if (action === 'install') {
    if (await installed()) throw new Error('登録済みです。変更する場合は先に npm run schedule:remove を実行してください。');
    const archive = validateArchive(JSON.parse(await readFile(path.join(root, 'data/archive.json'), 'utf8')));
    if (!archive.issues.length) throw new Error('先に npm run digest で初回発行・Copilot認証を確認してください。');
    await mkdir(path.dirname(agent), { recursive: true });
    await mkdir(path.join(root, '.run'), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>
<string>${escape(process.execPath)}</string><string>${escape(path.join(root, 'scripts/schedule.mjs'))}</string><string>run</string>
</array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>StartInterval</key><integer>900</integer>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${escape(path.join(root, '.run/schedule.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(root, '.run/schedule-error.log'))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path.dirname(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
`;
    await writeFile(agent, plist, { flag: 'wx', mode: 0o600 });
    try {
      await run('/bin/launchctl', ['bootstrap', domain, agent]);
      await run('/bin/launchctl', ['print', service]);
    } catch (error) {
      throw new Error(`launchdへの登録を確認できませんでした。設定ファイル: ${agent}\n${error.stderr || error.message}`, { cause: error });
    }
    console.log('自動発行を登録しました。日本時間6時以降、15分ごとに未発行を確認します。');
    console.log('スリープ中・ログアウト中は実行できません。復帰後に当日分を発行します。');
    return;
  }
  if (action === 'remove') {
    if (await installed()) await run('/bin/launchctl', ['bootout', service]);
    await rm(agent, { force: true });
    console.log('自動発行の登録を解除しました。');
    return;
  }
  throw new Error('使い方: node scripts/schedule.mjs install|remove|run');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
