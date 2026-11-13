import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadServerEnvironment } from '../server/environment.js';

test('local startup uses the edited .env key, while production preserves hosted secrets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-env-'));
  const envPath = path.join(directory, '.env');
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalMode = process.env.NODE_ENV;
  try {
    await writeFile(envPath, 'ANTHROPIC_API_KEY=fixture-file-key\n');
    process.env.NODE_ENV = 'development';
    process.env.ANTHROPIC_API_KEY = 'fixture-inherited-key';
    loadServerEnvironment({ path: envPath });
    assert.equal(process.env.ANTHROPIC_API_KEY, 'fixture-file-key');

    process.env.NODE_ENV = 'production';
    process.env.ANTHROPIC_API_KEY = 'fixture-hosted-key';
    loadServerEnvironment({ path: envPath });
    assert.equal(process.env.ANTHROPIC_API_KEY, 'fixture-hosted-key');
  } finally {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
    await rm(directory, { recursive: true, force: true });
  }
});
