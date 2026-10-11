import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, readApiKey, errorResult } from '../src/client.js';

const dummyKey = 'a'.repeat(64);
async function keyFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reppy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'key');
  await writeFile(path, dummyKey + '\n', { mode: 0o600 });
  return path;
}

test('key files require owned regular mode-600 files and bounded hex contents', async t => {
  const path = await keyFile(t);
  assert.equal(await readApiKey(path), dummyKey);
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(readApiKey(path), { code: 'KEY_FILE' });
    await chmod(path, 0o600);
    await symlink(path, path + '-link');
    await assert.rejects(readApiKey(path + '-link'), { code: 'KEY_FILE' });
  }
  await writeFile(path, dummyKey.repeat(2));
  await assert.rejects(readApiKey(path), { code: 'KEY_FILE' });
  await writeFile(path, 'not-a-key');
  await assert.rejects(readApiKey(path), { code: 'KEY_FILE' });
  await assert.rejects(readApiKey(undefined), { code: 'KEY_FILE' });
});

test('all six requests use a fixed HTTPS origin, header-only auth and unchanged JSON', async t => {
  const path = await keyFile(t);
  const seen = [];
  const payload = { unit: 'kg', items: [{ id: 'r_1', name: 'Synthetic routine' }], offset: 0, limit: 25, total: 1 };
  const client = createClient({ keyFile: path, fetchImpl: async (url, options) => {
    seen.push(String(url));
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + dummyKey);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(payload);
  } });
  for (const operation of ['ping', 'me', 'routines', 'workouts']) assert.deepEqual(await client.request(operation), payload);
  assert.deepEqual(await client.request('routines', { id: 'r_1' }), payload);
  assert.deepEqual(await client.request('workouts', { id: 'w-1' }), payload);
  assert.deepEqual(seen, [
    'https://api.reppyai.com/v1/ping', 'https://api.reppyai.com/v1/me',
    'https://api.reppyai.com/v1/routines?limit=25&offset=0', 'https://api.reppyai.com/v1/workouts?limit=25&offset=0',
    'https://api.reppyai.com/v1/routines/r_1', 'https://api.reppyai.com/v1/workouts/w-1'
  ]);
});

test('validation denies unknown operations, traversal, extra parameters and invalid pagination before fetch', async t => {
  let calls = 0;
  const client = createClient({ keyFile: await keyFile(t), fetchImpl: () => { calls++; } });
  for (const [op, args] of [
    ['users', {}], ['ping', { limit: 1 }], ['me', { id: 'x' }],
    ['routines', { id: '../me' }], ['routines', { id: '%252f' }],
    ['routines', { id: 'x', offset: 0 }], ['routines', { id: 'x'.repeat(129) }],
    ['workouts', { limit: 0 }], ['workouts', { limit: 101 }],
    ['workouts', { offset: 100001 }], ['workouts', { offset: -1 }],
    ['workouts', { limit: '25' }], ['workouts', { offset: 1.1 }],
    ['workouts', { limit: null }], ['workouts', { offset: null }],
    ['workouts', { account: 'other' }]
  ]) await assert.rejects(client.request(op, args), { code: 'ARGUMENTS' });
  assert.equal(calls, 0);
});

test('rate limit errors expose safe retry seconds without response contents or retries', async t => {
  let calls = 0;
  const client = createClient({ keyFile: await keyFile(t), fetchImpl: async () => {
    calls++;
    return new Response(dummyKey, { status: 429, headers: { 'Retry-After': '42' } });
  } });
  await assert.rejects(client.request('ping'), error => {
    assert.deepEqual(errorResult(error), { error: 'HTTP_ERROR', message: 'Reppy API returned HTTP 429.', status: 429, retryAfter: 42 });
    assert.ok(!JSON.stringify(errorResult(error)).includes(dummyKey));
    return true;
  });
  assert.equal(calls, 1);
});

test('malicious transport errors, response errors and unsafe retry headers cannot leak a key', async t => {
  const path = await keyFile(t);
  for (const fetchImpl of [
    async () => { throw new Error(dummyKey); },
    async () => new Response(dummyKey, { status: 401 }),
    async () => new Response(dummyKey, { status: 429, headers: { 'Retry-After': dummyKey } }),
    async () => new Response('{"error":"' + dummyKey + '"', { status: 200 })
  ]) {
    await assert.rejects(createClient({ keyFile: path, fetchImpl }).request('ping'), error => {
      assert.ok(!JSON.stringify(errorResult(error)).includes(dummyKey));
      return true;
    });
  }
  assert.deepEqual(errorResult(new Error(dummyKey)), { error: 'INTERNAL_ERROR', message: 'The client could not complete the request.' });
});

test('bounded response reads reject oversized declared and streamed bodies', async t => {
  const path = await keyFile(t);
  for (const response of [
    new Response('{}', { headers: { 'Content-Length': '4194305' } }),
    new Response(' '.repeat(4194305)),
    Response.json(['unsupported']),
    new Response(null)
  ]) await assert.rejects(createClient({ keyFile: path, fetchImpl: async () => response }).request('ping'), { code: 'RESPONSE_ERROR' });
});

test('an oversized declared body is cancelled before downloading it', async t => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const response = new Response(body, { headers: { 'Content-Length': '4194305' } });
  await assert.rejects(createClient({ keyFile: await keyFile(t), fetchImpl: async () => response }).request('ping'), { code: 'RESPONSE_ERROR' });
  assert.equal(cancelled, true);
});
