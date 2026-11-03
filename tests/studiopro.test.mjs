import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUninstallEntries, compareVersions, sameRelease, release, readScoopCatalog, latestPatches } from '../dist-test/studiopro.cjs';

const REG = String.raw`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\43e321a4_is1
    DisplayName    REG_SZ    Mendix 11.6.2
    DisplayIcon    REG_SZ    C:\Program Files\Mendix\11.6.2\modeler\studiopro.exe
    DisplayVersion    REG_SZ    11.6.2
    Publisher    REG_SZ    Mendix

HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{08B87F24}
    DisplayName    REG_SZ    Mendix Version Selector
    DisplayIcon    REG_SZ    C:\Program Files\Mendix\Version Selector\VersionSelector.exe
    DisplayVersion    REG_SZ    58.0
    Publisher    REG_SZ    Mendix

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\7e24d738_is1
    Inno Setup: App Path    REG_SZ    C:\Users\me\AppData\Local\Programs\Mendix
    DisplayIcon    REG_SZ    "C:\Users\me\AppData\Local\Programs\Mendix\10.24.28.129343\modeler\studiopro.exe",0
    DisplayVersion    REG_SZ    10.24.28.129343
    Publisher    REG_SZ    Mendix
    MajorVersion    REG_DWORD    0xa
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Other
    DisplayIcon    REG_SZ    C:\Other\studiopro.exe
    DisplayVersion    REG_SZ    1.0
    Publisher    REG_SZ    Someone Else
`.replace(/\n/g, '\r\n');

test('parses Studio Pro uninstall entries and skips other Mendix tools', () => {
  assert.deepEqual(parseUninstallEntries(REG), [
    { version: '11.6.2', executable: String.raw`C:\Program Files\Mendix\11.6.2\modeler\studiopro.exe` },
    { version: '10.24.28.129343', executable: String.raw`C:\Users\me\AppData\Local\Programs\Mendix\10.24.28.129343\modeler\studiopro.exe` },
  ]);
});
test('orders versions numerically and matches releases across build numbers', () => {
  assert.deepEqual(['9.24.35.71123', '11.6.2', '10.24.28.129343', '10.24.3'].sort((a, b) => compareVersions(b, a)),
    ['11.6.2', '10.24.28.129343', '10.24.3', '9.24.35.71123']);
  assert.equal(sameRelease('10.24.28.129343', '10.24.28'), true);
  assert.equal(sameRelease('10.24.28', '10.24.24'), false);
  assert.equal(release('10.24.28.129343'), '10.24.28');
  assert.equal(release('11.6.2'), '11.6.2');
});
test('reads the Scoop Mendix bucket: exact, machine and installed versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mx-scoop-'));
  try {
    const touch = async (...parts) => { await mkdir(path.dirname(path.join(root, ...parts)), { recursive: true }); await writeFile(path.join(root, ...parts), '{}'); };
    await touch('buckets', 'main', 'bucket', 'git.json');
    for (const name of ['mendix-studio-pro', 'mendix-studio-pro-10.24', 'mendix-studio-pro-10.24.27', 'mendix-studio-pro-10.24.28',
      'mendix-studio-pro-10.24.28-machine', 'mendix-studio-pro-9.24.35', 'mendix-studio-pro-11.6.2']) await touch('buckets', 'mendix', 'bucket', `${name}.json`);
    // An exact-version app and a floating alias, each with its version folder next to "current".
    await mkdir(path.join(root, 'apps', 'mendix-studio-pro-10.24.24', '10.24.24'), { recursive: true });
    await mkdir(path.join(root, 'apps', 'mendix-studio-pro-10.24', '10.24.28.129343'), { recursive: true });
    await mkdir(path.join(root, 'apps', 'mendix-studio-pro-10.24', 'current'), { recursive: true });
    const catalog = await readScoopCatalog(root);
    assert.equal(catalog.bucket, 'mendix');
    assert.deepEqual(catalog.versions, ['11.6.2', '10.24.28', '10.24.27', '9.24.35']);
    assert.deepEqual(catalog.machine, ['10.24.28']);
    assert.deepEqual(catalog.installed.sort(), ['10.24.24', '10.24.28']);
    assert.equal(await readScoopCatalog(path.join(root, 'missing')), undefined);
  } finally { await rm(root, { force: true, recursive: true }); }
});
test('picks the newest patch per minor version', () => {
  assert.deepEqual([...latestPatches(['10.24.9', '10.24.28', '10.6.25', '11.6.2', '11.6.12'])].sort(), ['10.24.28', '10.6.25', '11.6.12']);
});
