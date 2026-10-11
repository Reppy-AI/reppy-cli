#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, requestPath, ReppyError, errorResult } from './client.js';

function parse(argv) {
  const [operation, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--limit' || token === '--offset') {
      const key = token.slice(2);
      const value = rest[++i];
      if (Object.hasOwn(args, key) || typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new ReppyError('ARGUMENTS');
      args[key] = Number(value);
    } else {
      if (token.startsWith('-') || Object.hasOwn(args, 'id')) throw new ReppyError('ARGUMENTS');
      args.id = token;
    }
  }
  requestPath(operation, args);
  return { operation, args };
}

export async function run(argv, client = createClient(), output = value => process.stdout.write(value + '\n')) {
  try {
    const { operation, args } = parse(argv);
    output(JSON.stringify(await client.request(operation, args)));
    return 0;
  } catch (error) {
    output(JSON.stringify(errorResult(error)));
    return error instanceof ReppyError && error.code === 'ARGUMENTS' ? 2 : 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
