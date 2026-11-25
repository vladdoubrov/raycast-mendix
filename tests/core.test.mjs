import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateAppId, appIconExtension, mergeBranches, findLocalCheckouts, safeCheckoutFolderName, summarizeGitStatus, newBranchNameError } from '../dist-test/core.cjs';

const ID = '00000000-0000-4000-8000-000000000001';
test('validates Mendix app UUIDs', () => {
  assert.equal(validateAppId(ID), true);
  assert.equal(validateAppId('not-uuid'), false);
});
test('accepts new branch names that Git accepts and that are not taken', () => {
  const existing = ['main', 'feature/OOMO-1'];
  for (const ok of ['OOMO-2482', 'feature/OOMO-2482-fix', 'release_10.24', 'feature/café']) assert.equal(newBranchNameError(ok, existing), undefined, ok);
  for (const bad of ['', 'has space', 'a..b', '-x', 'a/', '/a', 'a//b', 'a.', 'x/.hidden', 'a.lock', 'a.lock/b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a@{1}', '@', 'tab\there']) {
    assert.ok(newBranchNameError(bad, existing), JSON.stringify(bad));
  }
  assert.match(newBranchNameError('main', existing), /already exists/);
  assert.match(newBranchNameError('Feature/oomo-1', existing), /differ only in case/);
});
test('accepts only supported app icon image types', () => {
  assert.equal(appIconExtension('C:\Logos\app.PNG'), '.png');
  assert.equal(appIconExtension('C:\Logos\app.jpeg'), '.jpg');
  assert.equal(appIconExtension('C:\Logos\app.svg'), '.svg');
  assert.equal(appIconExtension('C:\Logos\app.ico'), undefined);
  assert.equal(appIconExtension('C:\Logos.png\app'), undefined);
  assert.equal(appIconExtension('C:\Logos\app.constructor'), undefined);
});
test('merges local and remote branches by exact name', () => {
  const b = mergeBranches([{name:'main'},{name:'LDP_MX10'}], [{branch:'main',mprPath:'c',folder:'f'},{branch:'local-only',mprPath:'d',folder:'g'}]);
  assert.deepEqual(b.map(({name}) => name), ['local-only','main','LDP_MX10']);
  assert.equal(b.find(x=>x.name==='main').local.length,1);
});
test('discovers matching git repos and workspaces, excludes other apps', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mx-switcher-'));
  try {
    const mk = async (name, appId, branch) => {
      const dir = path.join(tmp, name);
      await mkdir(path.join(dir,'.git'), {recursive:true});
      await writeFile(path.join(dir,'.git','HEAD'), `ref: refs/heads/${branch}\n`);
      await writeFile(path.join(dir,'.git','config'), `[remote "origin"]\n  url = https://git.api.mendix.com/${appId}.git\n`);
      await writeFile(path.join(dir, `${name}.mpr`), '');
    };
    await mk('ProjectA', ID, 'feature/demo');
    await mk('Other', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'main');
    const found = await findLocalCheckouts({id:ID,name:'ProjectA'}, tmp);
    assert.equal(found.length,1);
    assert.equal(found[0].branch,'feature/demo');
  } finally { await rm(tmp,{force:true,recursive:true}); }
});
test('summarizes git status for the delete confirmation', () => {
  assert.deepEqual(summarizeGitStatus('## main...origin/main [ahead 2]\r\n M App.mpr\r\n?? notes.txt\r\n'), { files: [' M App.mpr', '?? notes.txt'], ahead: 2, upstream: true });
  assert.deepEqual(summarizeGitStatus('## main...origin/main\n'), { files: [], ahead: 0, upstream: true });
  assert.deepEqual(summarizeGitStatus('## local-only\n M App.mpr\n'), { files: [' M App.mpr'], ahead: 0, upstream: false });
  assert.deepEqual(summarizeGitStatus('## new_dev...origin/new_dev [gone]\n'), { files: [], ahead: 0, upstream: false });
});
test('sanitizes checkout folder names', () => {
  assert.equal(safeCheckoutFolderName({id:ID,name:'My App'},'feature/a:b'), 'My App-feature-a-b');
});


test('App Repository API uses MxToken and follows next cursor', async () => {
  const { fetchRemoteBranches } = await import('../dist-test/core.cjs');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options.headers.Authorization });
    const page = requests.length === 1
      ? { items: [{ name: 'main' }], cursors: { next: 'cursor123' } }
      : { items: [{ name: 'feature/test' }], cursors: {} };
    return { ok: true, json: async () => page };
  };
  try {
    const found = await fetchRemoteBranches(ID, 'test-token');
    assert.deepEqual(found.map(x => x.name), ['main', 'feature/test']);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].auth, 'MxToken test-token');
    assert.match(requests[1].url, /cursor=cursor123/);
  } finally { globalThis.fetch = originalFetch; }
});
