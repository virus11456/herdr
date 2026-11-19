import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(join(root, '.todo-test-'));
const cli = join(root, 'todo.mjs');
let executions = 0;
let groups = 0;

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
  executions += 1;
  assert.ifError(result.error);
  assert.equal(result.status, expected, JSON.stringify({ args, ...result }));
  if (expected === 0) {
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  assert.match(result.stderr, /^Error: .+/);
  assert.equal(result.stdout, '');
  return result;
}

try {
  assert.deepEqual(run(['list']), []);
  assert.deepEqual(await readdir(directory), []);
  const first = run(['add', '  買牛奶 🥛 / 日本語 / café  ']);
  assert.deepEqual(first, { id: 1, text: '  買牛奶 🥛 / 日本語 / café  ', done: false });
  assert.deepEqual(run(['list']), [first]);
  assert.deepEqual(run(['done', '1']), { ...first, done: true });
  assert.deepEqual(run(['done', '1']), { ...first, done: true });
  const second = run(['add', 'next', 'task']);
  assert.deepEqual(second, { id: 2, text: 'next task', done: false });
  assert.deepEqual(run(['list']), [{ ...first, done: true }, second]);
  groups += 1;

  const custom = join(directory, '另一份 清單.json');
  assert.equal(run(['--file', custom, 'add', '獨立資料']).id, 1);
  assert.equal(run(['list', '--file', custom]).length, 1);
  assert.equal(run(['done', '1', '--file', custom]).done, true);
  assert.equal(run(['--file', custom, 'add', '--', '--file literal']).text, '--file literal');
  assert.equal(run(['list']).length, 2);
  groups += 1;

  const defaultFile = join(directory, 'tasks.json');
  const original = await readFile(defaultFile);
  for (const args of [
    ['add'], ['add', ' \t\n　'], ['done', '999'], ['done'], ['done', '0'],
    ['done', '-1'], ['done', '1.5'], ['done', '9007199254740992'], ['done', '1', '2'],
    ['unknown'], [], ['list', 'extra'], ['--bad'], ['--file'],
    ['--file', ''], ['--file', custom, '--file', custom, 'list'],
  ]) {
    run(args, 1);
    assert.deepEqual(await readFile(defaultFile), original);
  }
  groups += 1;

  const malformed = join(directory, 'invalid.json');
  for (const contents of [
    '{broken JSON', '', 'null', '[]', '{}',
    JSON.stringify({ version: 1, nextId: 1, tasks: [{ id: 1, text: 'x', done: false }] }),
    JSON.stringify({ version: 1, nextId: 3, tasks: [{ id: 1, text: 'x', done: false }, { id: 1, text: 'y', done: false }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ id: 1, text: '　', done: false }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ id: 1, text: 'x', done: 'false' }] }),
  ]) {
    await writeFile(malformed, contents);
    for (const args of [['add', 'new'], ['list'], ['done', '1']]) {
      run(['--file', malformed, ...args], 1);
      assert.equal(await readFile(malformed, 'utf8'), contents);
    }
  }
  groups += 1;

  const missing = join(directory, 'missing.json');
  run(['--file', missing, 'done', '1'], 1);
  assert.equal((await readdir(directory)).includes('missing.json'), false);
  run(['--file', join(directory, 'absent', 'tasks.json'), 'add', 'x'], 1);
  run(['--file', directory, 'list'], 1);
  const exhausted = JSON.stringify({ version: 1, nextId: Number.MAX_SAFE_INTEGER, tasks: [] });
  await writeFile(malformed, exhausted);
  run(['--file', malformed, 'add', 'overflow'], 1);
  assert.equal(await readFile(malformed, 'utf8'), exhausted);
  const reserved = JSON.stringify({ version: 1, nextId: 42, tasks: [] });
  await writeFile(malformed, reserved);
  assert.equal(run(['--file', malformed, 'add', 'preserve counter']).id, 42);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  groups += 1;

  process.stdout.write(`PASS: ${groups} test groups; ${executions} CLI executions (success: exit 0; expected errors: exit 1).\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
