import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

test('CLI passes list defaults, strict pagination and detail IDs through to the client', async () => {
  const seen = [];
  const payload = { unit: 'lb', items: [], offset: 2, limit: 3, total: 0 };
  const request = async (...args) => { seen.push(args); return payload; };
  const output = [];
  for (const args of [['ping'], ['me'], ['routines'], ['workouts', '--offset', '2', '--limit', '3'], ['routines', 'routine-1'], ['workouts', 'workout_1']]) {
    assert.equal(await run(args, { request }, value => output.push(value)), 0);
  }
  assert.deepEqual(seen, [['ping', {}], ['me', {}], ['routines', {}], ['workouts', { offset: 2, limit: 3 }], ['routines', { id: 'routine-1' }], ['workouts', { id: 'workout_1' }]]);
  assert.deepEqual(output.map(JSON.parse), Array(6).fill(payload));
});

test('CLI rejects unknown, duplicate, malformed and credential arguments without making requests', async () => {
  let calls = 0;
  for (const args of [[], ['unknown'], ['ping', '--limit', '1'], ['workouts', '--limit', '01'], ['workouts', '--offset', '-1'], ['workouts', '--limit', '2', '--limit', '3'], ['workouts', '--api-key', 'dummy'], ['routines', '../me'], ['routines', 'id', '--limit', '1'], ['workouts', '--limit'], ['me', 'id']]) {
    const output = [];
    const status = await run(args, { request: async () => { calls++; } }, value => output.push(value));
    assert.notEqual(status, 0);
    assert.equal(JSON.parse(output[0]).error, 'ARGUMENTS');
  }
  assert.equal(calls, 0);
});

test('CLI executable produces only JSON and a nonzero exit on missing credentials', () => {
  const env = { ...process.env };
  delete env.REPPY_API_KEY_FILE;
  const result = spawnSync(process.execPath, ['src/cli.js', 'ping'], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error, 'KEY_FILE');
  assert.equal(result.stderr, '');
});

test('CLI executable uses real HTTP stubs, preserves JSON and reports 429 without retries', async t => {
  const dummyKey = 'c'.repeat(64);
  const dir = await mkdtemp(join(tmpdir(), 'reppy-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'key');
  await writeFile(keyFile, dummyKey, { mode: 0o600 });
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/v1/workouts/rate-limited') {
      res.writeHead(429, { 'Retry-After': '9' });
      res.end(dummyKey);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"unit":"kg","items":[],"offset":2,"limit":3,"total":0}');
    }
  });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, REPPY_API_KEY_FILE: keyFile, REPPY_TEST_API_ORIGIN: `http://localhost:${server.address().port}` }
  };
  const args = ['--import', fileURLToPath(new URL('./mock-fetch.js', import.meta.url)), 'src/cli.js'];
  const result = await promisify(execFile)(process.execPath, [...args, 'routines', '--limit', '3', '--offset', '2'], options);
  assert.deepEqual(JSON.parse(result.stdout), { unit: 'kg', items: [], offset: 2, limit: 3, total: 0 });
  assert.equal(result.stderr, '');
  assert.deepEqual(calls, [{ path: '/v1/routines?limit=3&offset=2', authorization: 'Bearer ' + dummyKey }]);
  await assert.rejects(promisify(execFile)(process.execPath, [...args, 'workouts', 'rate-limited'], options), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).retryAfter, 9);
    assert.ok(!error.stdout.includes(dummyKey));
    assert.equal(error.stderr, '');
    return true;
  });
  assert.equal(calls.length, 2);
});
