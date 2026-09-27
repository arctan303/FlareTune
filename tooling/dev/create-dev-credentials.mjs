#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, 'server/dev');
const credentialsPath = resolve(directory, 'credentials.json');
const varsPath = resolve(directory, '.dev.vars');
const setupSecret = randomBytes(48).toString('base64url');
const credentials = {
  username: 'admin',
  password: randomBytes(24).toString('base64url'),
  setupSecret,
};

await mkdir(directory, { recursive: true });
await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
});
await writeFile(varsPath, `SETUP_SECRET="${setupSecret}"\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
});
console.log('Created ignored dev credentials and Wrangler local secret files.');
