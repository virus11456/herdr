#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hooksSettings } from './team-runtime.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const app = path.join(home, '.config/herdr-app');
const core = path.join(home, '.config/herdr-core');
const bin = path.join(home, '.local/bin');
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";

function findTool(name) {
  for (const folder of [bin, ...(process.env.PATH || '').split(path.delimiter)]) {
    if (!folder) continue;
    const file = path.join(folder, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return path.resolve(file);
    } catch {}
  }
  throw new Error(`找不到 ${name}。請先安裝並完成登入，再執行安裝；本安裝器不處理憑證。`);
}

try {
  const args = process.argv.slice(2);
  if (args.some(x => !['--dry-run', '--help'].includes(x))) throw new Error('用法：node install.mjs [--dry-run]');
  if (args.includes('--help')) {
    console.log('node install.mjs --dry-run：列出計畫；node install.mjs：備份後安裝。請先閱讀 README.md。');
    process.exit(0);
  }
  if (process.platform === 'win32') throw new Error('此安裝包使用 POSIX shell，僅支援 macOS／Linux。');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更新版本。');
  const tools = Object.fromEntries(['hc', 'herdr-app', 'claude', 'codex', 'mcode'].map(name => [name, findTool(name)]));
  const replace = {
    '@NODE_SHELL@': quote(process.execPath),
    '@NOTIFY_CONFIG@': quote('notify=' + JSON.stringify([process.execPath, path.join(app, 'team-runtime.mjs'), 'codex-notify'])),
    '@CLAUDE_COMMAND@': JSON.stringify(quote(path.join(bin, 'herdr-team-claude'))),
    '@CODEX_COMMAND@': JSON.stringify(quote(path.join(bin, 'codex')) + ' --no-daemon'),
    '@MINIMAX_COMMAND@': JSON.stringify(quote(path.join(bin, 'mcode')))
  };
  const files = [
    ['mods/team-chat/main.js', path.join(app, 'mods/team-chat/main.js')],
    ['mods/team-chat/mod.json', path.join(app, 'mods/team-chat/mod.json')],
    ['layouts/team-work.json', path.join(app, 'layouts/team-work.json')],
    ['team-runtime.mjs', path.join(app, 'team-runtime.mjs')],
    ...['lead', 'backup', 'claude', 'runtime'].map(name => [`bin/herdr-team-${name}`, path.join(bin, `herdr-team-${name}`)]),
    ...['herdr-claude-task', 'herdr-codex-implement', 'herdr-minimax-cn'].map(name => [`templates/${name}.md`, path.join(core, `templates/${name}.md`)])
  ].map(([source, target]) => {
    let content = fs.readFileSync(path.join(root, source), 'utf8');
    for (const [marker, value] of Object.entries(replace)) content = content.replaceAll(marker, value);
    if (/@[A-Z_]+@/.test(content)) throw new Error(`尚未展開的安裝標記：${source}`);
    return { target, content, mode: source.startsWith('bin/') ? 0o755 : 0o644 };
  });
  files.push({ target: path.join(app, 'team-claude-settings.json'), content: JSON.stringify(hooksSettings(path.join(app, 'team-runtime.mjs'), process.execPath), null, 2) + '\n', mode: 0o600 });
  // Runtime resolves tools from ~/.local/bin; link only commands absent there.
  const links = Object.entries(tools).filter(([name, source]) => path.join(bin, name) !== source).map(([name, source]) => ({target: path.join(bin, name), source}));
  for (const link of links) {
    if (fs.existsSync(link.target)) throw new Error(`工具位置已有檔案：${link.target}`);
  }
  console.log('待安裝檔案：');
  for (const item of files) console.log('  ' + item.target);
  for (const item of links) console.log(`  ${item.target} -> ${item.source}`);
  if (args.includes('--dry-run')) {
    console.log('Dry run 完成；未修改任何設定，未啟動代理。');
    process.exit(0);
  }
  const backup = path.join(app, 'team-work-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  const manifest = [];
  for (const file of files) {
    const rel = path.relative(home, file.target);
    let old;
    try { old = fs.lstatSync(file.target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) {
      if (!old.isFile() && !old.isSymbolicLink()) throw new Error(`安裝目的地不是檔案：${file.target}`);
      const saved = path.join(backup, rel);
      fs.mkdirSync(path.dirname(saved), {recursive: true, mode: 0o700});
      if (old.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(file.target), saved);
      else fs.copyFileSync(file.target, saved);
      manifest.push({ target: file.target, backup: saved });
    } else manifest.push({ target: file.target, backup: null });
  }
  fs.mkdirSync(backup, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.target), {recursive: true});
    const tmp = file.target + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, file.content, {mode: file.mode});
    fs.renameSync(tmp, file.target);
  }
  for (const link of links) fs.symlinkSync(link.source, link.target);
  console.log(`已安裝。原檔備份與清單：${backup}`);
  console.log('請將 ~/.local/bin 加入 PATH，依 README 執行檢查與版面切換。未啟動代理。');
} catch (error) {
  console.error('安裝失敗：' + error.message);
  process.exitCode = 1;
}
