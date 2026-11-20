import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function parseArgs(args) {
  let file = 'tasks.json';
  let hasFile = false;
  let literal = false;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!literal && arg === '--') {
      literal = true;
    } else if (!literal && arg === '--file') {
      if (hasFile || !args[index + 1]?.trim() || args[index + 1].startsWith('--')) {
        throw new Error('--file requires one nonempty path and may appear only once.');
      }
      file = args[++index];
      hasFile = true;
    } else if (!literal && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}. Use -- before literal text starting with a dash.`);
    } else {
      positional.push(arg);
    }
  }
  const [command, ...values] = positional;
  if (!['add', 'list', 'done'].includes(command)) {
    throw new Error(`Unknown command: ${command ?? '(missing)'}. Expected add, list, or done.`);
  }
  if (command === 'add' && !values.join(' ').trim()) {
    throw new Error('Task text must not be blank.');
  }
  if (command === 'list' && values.length !== 0) {
    throw new Error('list does not accept arguments.');
  }
  if (command === 'done' && (values.length !== 1 || !/^[1-9]\d*$/.test(values[0]) || !Number.isSafeInteger(Number(values[0])))) {
    throw new Error('done requires one positive, safe integer ID.');
  }
  return { file: resolve(file), command, values };
}

function validateStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || store.version !== 1 || !Array.isArray(store.tasks)
    || !Number.isSafeInteger(store.nextId) || store.nextId < 1) {
    throw new Error('Expected {version: 1, nextId: positive integer, tasks: array}.');
  }
  const ids = new Set();
  for (const task of store.tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || !Number.isSafeInteger(task.id) || task.id < 1 || ids.has(task.id)
      || task.id >= store.nextId || typeof task.text !== 'string'
      || !task.text.trim() || typeof task.done !== 'boolean') {
      throw new Error('Tasks require unique positive IDs below nextId, nonblank text, and a boolean done field.');
    }
    ids.add(task.id);
  }
  return store;
}

async function loadStore(file) {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, nextId: 1, tasks: [] };
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  try {
    return validateStore(JSON.parse(contents));
  } catch (error) {
    throw new Error(`Invalid JSON data in ${file}: ${error.message}`);
  }
}

async function saveStore(file, store) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } catch (error) {
    throw new Error(`Cannot save ${file}: ${error.message}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
  }
}

async function main() {
  const { file, command, values } = parseArgs(process.argv.slice(2));
  const store = await loadStore(file);
  let result;
  if (command === 'list') {
    result = store.tasks;
  } else if (command === 'add') {
    if (store.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Task ID space is exhausted.');
    result = { id: store.nextId, text: values.join(' '), done: false };
    store.nextId += 1;
    store.tasks.push(result);
    await saveStore(file, store);
  } else {
    result = store.tasks.find((task) => task.id === Number(values[0]));
    if (!result) throw new Error(`Unknown task ID: ${values[0]}.`);
    if (!result.done) {
      result.done = true;
      await saveStore(file, store);
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
