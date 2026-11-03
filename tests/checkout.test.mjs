import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalRemote, checkoutTarget, projectRoot, cacheDirectory } from '../dist-test/checkout.cjs';
const id = '00000000-0000-4000-8000-000000000001';
test('canonical remote preserves the app boundary required by Studio Pro credentials', () => {
  assert.equal(canonicalRemote(id.toUpperCase()), `https://git.api.mendix.com/${id}.git/`);
  assert.throws(() => canonicalRemote('bad-id'));
});
test('dedicated roots take precedence and cache identity uses the UUID', () => {
  const app = { id, name: 'App', localRoot: path.resolve('dedicated') };
  assert.equal(projectRoot(app, { projectsRoot: path.resolve('global') }), app.localRoot);
  assert.equal(cacheDirectory(app, {}), path.join(app.localRoot, '.mendix-switcher-cache', 'v1', id));
});
test('name collisions get deterministic suffixes without overwriting folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mx-target-test-'));
  try {
    const app = { id, name: 'App' };
    const first = await checkoutTarget(app, 'feature/a', root);
    await mkdir(first);
    await writeFile(path.join(first, 'keep.txt'), 'user data');
    const other = await checkoutTarget(app, 'feature:a', root);
    assert.notEqual(first, other);
    await mkdir(other);
    await assert.rejects(checkoutTarget(app, 'feature:a', root), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
