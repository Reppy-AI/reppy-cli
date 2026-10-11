import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const messages = {
  ARGUMENTS: 'Use ping, me, routines [ID], or workouts [ID]; lists accept --limit 1..100 and --offset 0..100000.',
  KEY_FILE: 'Set REPPY_API_KEY_FILE to an owned private regular key file containing 64 hexadecimal characters.',
  NETWORK_ERROR: 'The Reppy API request failed or timed out.',
  RESPONSE_ERROR: 'The Reppy API response was invalid or exceeded 4 MiB.',
  INTERNAL_ERROR: 'The client could not complete the request.'
};

export class ReppyError extends Error {
  constructor(code, status, retryAfter) {
    super(code === 'HTTP_ERROR' ? `Reppy API returned HTTP ${status}.` : messages[code]);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function errorResult(error) {
  if (!(error instanceof ReppyError)) return { error: 'INTERNAL_ERROR', message: messages.INTERNAL_ERROR };
  const result = { error: error.code, message: error.message };
  if (error.status !== undefined) result.status = error.status;
  if (error.retryAfter !== undefined) result.retryAfter = error.retryAfter;
  return result;
}

export async function readApiKey(path) {
  let file;
  try {
    if (typeof path !== 'string' || !path || (await lstat(path)).isSymbolicLink()) throw new Error();
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 64 || stat.size > 66) throw new Error();
    if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600)) throw new Error();
    const buffer = Buffer.alloc(67);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (!/^[0-9a-fA-F]{64}(?:\r?\n)?$/.test(text)) throw new Error();
    return text.slice(0, 64);
  } catch {
    throw new ReppyError('KEY_FILE');
  } finally {
    await file?.close();
  }
}

export function requestPath(operation, args = {}) {
  if (!['ping', 'me', 'routines', 'workouts'].includes(operation) || !args || typeof args !== 'object' || Array.isArray(args)) throw new ReppyError('ARGUMENTS');
  const keys = Object.keys(args);
  const base = `/v1/${operation}`;
  if (operation === 'ping' || operation === 'me') {
    if (keys.length) throw new ReppyError('ARGUMENTS');
    return base;
  }
  if (Object.hasOwn(args, 'id')) {
    if (keys.length !== 1 || typeof args.id !== 'string' || !ID_PATTERN.test(args.id)) throw new ReppyError('ARGUMENTS');
    return `${base}/${args.id}`;
  }
  if (keys.some(key => !['limit', 'offset'].includes(key))) throw new ReppyError('ARGUMENTS');
  const limit = Object.hasOwn(args, 'limit') ? args.limit : 25;
  const offset = Object.hasOwn(args, 'offset') ? args.offset : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ReppyError('ARGUMENTS');
  return `${base}?limit=${limit}&offset=${offset}`;
}

async function responseJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new ReppyError('RESPONSE_ERROR');
  }
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ReppyError('RESPONSE_ERROR');
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ReppyError('RESPONSE_ERROR');
    return result;
  } catch (error) {
    if (error instanceof ReppyError) throw error;
    throw new ReppyError('RESPONSE_ERROR');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createClient({ keyFile = process.env.REPPY_API_KEY_FILE, fetchImpl = globalThis.fetch } = {}) {
  return {
    async request(operation, args) {
      const path = requestPath(operation, args);
      const key = await readApiKey(keyFile);
      let response;
      try {
        response = await fetchImpl(`https://api.reppyai.com${path}`, {
          method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(15000)
        });
      } catch {
        throw new ReppyError('NETWORK_ERROR');
      }
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const retryAfter = response.status === 429 && /^\d{1,5}$/.test(retry || '') && Number(retry) <= 86400 ? Number(retry) : undefined;
        await response.body?.cancel().catch(() => {});
        throw new ReppyError('HTTP_ERROR', response.status, retryAfter);
      }
      return responseJson(response);
    }
  };
}
