import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const worker = fileURLToPath(new URL('../assets/checkout-worker.ps1', import.meta.url));
const appId = '00000000-0000-4000-8000-000000000001';
const ps = process.env.MX_TEST_POWERSHELL || 'powershell.exe';
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args], { windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();

test('worker integration: full, warm, seeded, partial, branch creation, cancellation and safe failure', { skip: process.platform !== 'win32', timeout: 420000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mx-worker-test-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const projectsRoot = path.join(root, 'projects with spaces é');
  const cacheRoot = path.join(root, '.mendix-switcher-cache', 'v1', appId);
  try {
    await mkdir(source); await mkdir(projectsRoot);
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(source, 'App.mpr'), 'fixture only\n');
    await writeFile(path.join(source, 'readme.txt'), 'LF content\n');
    await git(source, 'add', '.'); await git(source, 'commit', '-m', 'fixture');
    await git(source, 'notes', '--ref=mx_metadata', 'add', '-m', 'fixture notes');
    await git(source, 'branch', 'feature/café');
    await git(source, 'tag', 'fixture-v1');
    await git(root, 'clone', '--bare', source, remote);
    await git(remote, 'config', 'uploadpack.allowFilter', 'true');
    await git(source, 'push', remote, 'refs/notes/mx_metadata');
    const remoteUrl = pathToFileURL(remote).href + '/';
    let counter = 0;
    async function run(overrides = {}, cancel = false, { noLaunch = true } = {}) {
      const operationId = randomUUID();
      const directory = path.join(root, 'operations', operationId);
      await mkdir(directory, { recursive: true });
      const request = { schemaVersion: 1, operationId, appId, appName: 'App', action: 'checkout', remoteUrl,
        branch: 'main', projectsRoot, target: path.join(projectsRoot, `copy-${++counter}`), cacheRoot,
        cloneType: 'full', reuseLocalRepositories: true, seeds: [], diagnostics: false, studioProExecutable: '', launch: true, openTerminal: false, ...overrides };
      const requestFile = path.join(directory, 'request.json');
      await writeFile(requestFile, JSON.stringify(request));
      if (cancel) await writeFile(path.join(directory, 'cancel.request'), 'cancel');
      const result = await new Promise((resolve, reject) => {
        const child = spawn(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',worker,'-RequestFile',requestFile,...(noLaunch ? ['-NoLaunch'] : []),'-AllowLocalTestRemote'], { windowsHide: true });
        let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Worker timeout: ' + output)); }, 60000);
        child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); });
      });
      const status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8'));
      return { ...result, request, status, directory };
    }
    function success(result) { assert.equal(result.code, 0, result.output); assert.equal(result.status.state, 'completed', result.output); }
    const cold = await run();
    success(cold);
    await t.test('cold full cache yields a clean independent checkout and notes', async () => {
      success(cold); assert.equal(cold.status.strategy, 'cold-full-cache');
      assert.equal(await git(cold.request.target, 'status', '--porcelain'), '');
      assert.equal(await git(cold.request.target, 'config', 'remote.origin.url'), remoteUrl);
      assert.equal(await git(cold.request.target, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
      assert.equal(await git(cold.request.target, 'config', 'notes.rewriteMode'), 'overwrite');
      assert.equal(await git(cold.request.target, 'config', 'notes.rewrite.rebase'), 'true');
      assert.equal(await git(cold.request.target, 'config', 'mendix.sprintr-project-id'), appId);
      assert.equal(await readFile(path.join(cold.request.target, 'readme.txt'), 'utf8'), 'LF content\n');
      assert.match(await git(cold.request.target, 'notes', '--ref=mx_metadata', 'show'), /fixture notes/);
      await assert.rejects(access(path.join(cold.request.target, '.git', 'objects', 'info', 'alternates')));
    });
    await t.test('default cache folder is hidden', async () => {
      const { stdout } = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -Force -LiteralPath $env:MX_TEST_PATH).Attributes'],
        { windowsHide: true, env: { ...process.env, MX_TEST_PATH: path.join(root, '.mendix-switcher-cache') } });
      assert.match(stdout, /Hidden/);
    });
    await t.test('launch: false publishes without starting Studio Pro', async () => {
      // A missing executable makes any launch attempt fail, so completing proves the launch was skipped.
      const studioProExecutable = path.join(root, 'missing', 'studiopro.exe');
      const cloneOnly = await run({ launch: false, studioProExecutable }, false, { noLaunch: false });
      success(cloneOnly); assert.equal(cloneOnly.status.ready, true);
      const launched = await run({ studioProExecutable }, false, { noLaunch: false });
      assert.equal(launched.status.state, 'launch_failed', launched.output);
    });
    await t.test('warm cache updates branches, metadata and tags from server', async () => {
      await git(source, 'branch', 'new-branch'); await git(source, 'tag', 'fixture-v2');
      await git(source, 'push', remote, 'new-branch', 'fixture-v2');
      const warm = await run({ branch: 'new-branch' }); success(warm);
      assert.equal(warm.status.strategy, 'warm-full-cache');
      assert.equal(await git(warm.request.target, 'symbolic-ref', '--short', 'HEAD'), 'new-branch');
      assert.match(await git(warm.request.target, 'tag', '--list'), /fixture-v2/);
    });
    await t.test('cache removal does not break existing checkouts', async () => {
      success(await run({ action: 'remove-cache' }));
      await git(cold.request.target, 'fsck', '--full');
      await git(cold.request.target, 'fetch', 'origin');
      await git(cold.request.target, 'merge', '--ff-only', 'origin/main');
    });
    await t.test('seeding reads remote tracking refs and preserves dirty source work', async () => {
      // A seed on a non-default branch must not become the main line (origin/HEAD) of later checkouts.
      await git(cold.request.target, 'checkout', 'feature/café');
      await writeFile(path.join(cold.request.target, 'readme.txt'), 'uncommitted user edit\n');
      const seeded = await run({ branch: 'feature/café', seeds: [cold.request.target] }); success(seeded);
      assert.equal(seeded.status.strategy, 'seeded-full-cache');
      assert.equal(await git(seeded.request.target, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
      assert.equal(await readFile(path.join(cold.request.target, 'readme.txt'), 'utf8'), 'uncommitted user edit\n');
      assert.equal(await readFile(path.join(seeded.request.target, 'readme.txt'), 'utf8'), 'LF content\n');
    });
    await t.test('partial clone is direct, promisor aware, clean and fetchable', async () => {
      const partial = await run({ cloneType: 'partial' }); success(partial);
      assert.equal(partial.status.strategy, 'direct-partial');
      assert.equal(await git(partial.request.target, 'config', 'remote.origin.promisor'), 'true');
      assert.equal(await git(partial.request.target, 'status', '--porcelain'), '');
      await git(partial.request.target, 'fetch', 'origin');
      await git(partial.request.target, 'merge', '--ff-only', 'origin/main');
    });
    await t.test('direct full clone bypasses cache', async () => {
      const direct = await run({ reuseLocalRepositories: false }); success(direct);
      assert.equal(direct.status.strategy, 'direct-full');
      await writeFile(path.join(source, 'new-file.txt'), 'remote update\n');
      await git(source, 'add', '.'); await git(source, 'commit', '-m', 'advance main');
      await git(source, 'push', remote, 'main');
      await git(direct.request.target, 'fetch', 'origin');
      await git(direct.request.target, 'merge', '--ff-only', 'origin/main');
      assert.equal(await readFile(path.join(direct.request.target, 'new-file.txt'), 'utf8'), 'remote update\n');
    });
    const create = (branch, overrides = {}) => run({ action: 'create-branch', branch, baseBranch: 'main', download: true, ...overrides });
    const remoteRef = (branch) => git(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => '');
    async function assertNewBranchCheckout(result, branch, mainTip) {
      success(result);
      assert.equal(await remoteRef(branch), mainTip);
      const target = result.request.target;
      assert.equal(await git(target, 'symbolic-ref', '--short', 'HEAD'), branch);
      assert.equal(await git(target, 'rev-parse', 'HEAD'), mainTip);
      assert.equal(await git(target, 'rev-parse', '--abbrev-ref', '@{upstream}'), `origin/${branch}`);
      assert.equal(await git(target, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'), branch);
      assert.equal(await git(target, 'status', '--porcelain'), '');
      assert.match(await git(target, 'notes', '--ref=mx_metadata', 'list'), /\S/);
    }
    await t.test('create-branch from the cache pushes the latest main and checks out the new branch', async () => {
      const mainTip = await git(remote, 'rev-parse', 'refs/heads/main');
      const created = await create('feature/new-cached');
      await assertNewBranchCheckout(created, 'feature/new-cached', mainTip);
      assert.equal(created.status.strategy, 'warm-full-cache');
      assert.equal(await git(cacheRoot + '/full.git', 'rev-parse', 'refs/heads/feature/new-cached'), mainTip);
    });
    await t.test('create-branch direct and partial clones check out the new branch', async () => {
      const mainTip = await git(remote, 'rev-parse', 'refs/heads/main');
      await assertNewBranchCheckout(await create('feature/new-direct', { reuseLocalRepositories: false }), 'feature/new-direct', mainTip);
      await assertNewBranchCheckout(await create('feature/new-partial', { cloneType: 'partial' }), 'feature/new-partial', mainTip);
    });
    await t.test('create-branch without download creates only the server branch', async () => {
      const mainTip = await git(remote, 'rev-parse', 'refs/heads/main');
      const before = await readdir(projectsRoot);
      const cached = await create('feature/server-only-cached', { download: false, target: '' });
      success(cached); assert.equal(cached.status.ready, false);
      assert.equal(await remoteRef('feature/server-only-cached'), mainTip);
      const direct = await create('feature/server-only-direct', { download: false, target: '', reuseLocalRepositories: false });
      success(direct); assert.equal(direct.status.strategy, 'direct-create');
      assert.equal(await remoteRef('feature/server-only-direct'), mainTip);
      await assert.rejects(access(path.join(direct.directory, 'push.git')));
      assert.deepEqual(await readdir(projectsRoot), before);
    });
    await t.test('create-branch never moves an existing branch or creates from a missing base', async () => {
      await git(source, 'commit', '--allow-empty', '-m', 'advance main again');
      await git(source, 'push', remote, 'main');
      const existing = await remoteRef('feature/new-cached');
      for (const [name, overrides] of [['feature/new-cached', {}], ['Feature/New-Cached', {}], ['feature/new-cached', { reuseLocalRepositories: false }],
        ['feature/new-cached', { download: false, target: '', reuseLocalRepositories: false }]]) {
        const failed = await create(name, overrides);
        assert.equal(failed.status.state, 'failed', failed.output);
        assert.match(failed.status.error, /already exists on the server/);
        if (failed.request.target) await assert.rejects(access(failed.request.target));
      }
      assert.equal(await remoteRef('feature/new-cached'), existing);
      // Listed, not resolved: on a case-insensitive disk a loose ref resolves under any casing.
      assert.doesNotMatch(await git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), /refs\/heads\/Feature\/New-Cached/);
      const noBase = await create('feature/no-base', { baseBranch: 'does-not-exist' });
      assert.equal(noBase.status.state, 'failed');
      assert.equal(await remoteRef('feature/no-base'), '');
      const invalid = await create('bad..name');
      assert.equal(invalid.status.state, 'failed');
      assert.equal(invalid.status.stage, 'preflight');
    });
    await t.test('unsupported filtering is recorded as full fallback', async () => {
      await git(remote, 'config', 'uploadpack.allowFilter', 'false');
      const fallback = await run({ cloneType: 'partial' }); success(fallback);
      assert.equal(fallback.status.strategy, 'direct-full-filter-unavailable');
      await assert.rejects(git(fallback.request.target, 'config', '--get', 'remote.origin.promisor'));
    });
    await t.test('missing branch, cancellation and occupied target never publish', async () => {
      const missing = await run({ branch: 'does-not-exist' }); assert.equal(missing.status.state, 'failed');
      await assert.rejects(access(missing.request.target));
      const cancelled = await run({}, true); assert.equal(cancelled.status.state, 'cancelled');
      await assert.rejects(access(cancelled.request.target));
      const occupied = await run({ target: cold.request.target }); assert.equal(occupied.status.state, 'failed');
      assert.equal(await readFile(path.join(cold.request.target, 'readme.txt'), 'utf8'), 'uncommitted user edit\n');
    });
    await t.test('concurrent requests for one target serialize and never nest checkouts', async () => {
      const target = path.join(projectsRoot, 'concurrent');
      const results = await Promise.all([run({ target }), run({ target })]);
      assert.equal(results.filter(r => r.status.state === 'completed').length, 1, results.map(r => r.output).join('\n'));
      assert.equal(results.filter(r => r.status.state === 'failed').length, 1);
      assert.equal(await git(target, 'status', '--porcelain'), '');
      for (const result of results) await assert.rejects(access(path.join(target, `.mx-checkout-${result.request.operationId}`)));
    });
    await t.test('lock files are removed once operations finish', async () => {
      assert.deepEqual((await readdir(projectsRoot)).filter(name => name.endsWith('.lock')), []);
      await assert.rejects(access(path.join(cacheRoot, 'cache.lock')));
    });
    await t.test('missing Mendix metadata fails before publishing and removes staging', async () => {
      await git(remote, 'update-ref', '-d', 'refs/notes/mx_metadata');
      const failed = await run({ reuseLocalRepositories: false });
      assert.equal(failed.status.state, 'failed');
      assert.equal(failed.status.stage, 'fetch-metadata');
      await assert.rejects(access(failed.request.target));
      // The clone created staging before the metadata fetch failed.
      assert.match(failed.output, /Removed incomplete folder/);
      await assert.rejects(access(path.join(projectsRoot, `.mx-checkout-${failed.request.operationId}`)));
    });
    await t.test('failed cold cache build removes its build folder', async () => {
      success(await run({ action: 'remove-cache' }));
      const failed = await run();
      assert.equal(failed.status.state, 'failed');
      assert.equal(failed.status.stage, 'prepare-cache');
      assert.match(failed.output, /Removed incomplete folder/);
      assert.deepEqual((await readdir(cacheRoot)).filter(name => name.startsWith('.building-') || name === 'full.git'), []);
      await assert.rejects(access(path.join(projectsRoot, `.mx-checkout-${failed.request.operationId}`)));
    });
  } finally {
    // This test owns the mkdtemp directory exclusively; never remove a user checkout.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
