import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {verifySourceLayout} from '../scripts/source-layout.mjs';
import {ROOT} from './helpers.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bridge-source-layout-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'tests'));
  const canonical = path.join(root, 'tests/openjev-sidecar.test.mjs');
  const retired = path.join(root, 'tests/openjev-addon.test.mjs');
  await fs.writeFile(canonical, '// canonical suite fixture\n');
  return {root, canonical, retired};
}

test('source layout accepts the maintained suite without modifying files', async t => {
  const {root, canonical} = await fixture(t);
  const before = await fs.readFile(canonical);
  assert.deepEqual(await verifySourceLayout(root), {verified: true});
  assert.deepEqual(await fs.readdir(path.join(root, 'tests')), ['openjev-sidecar.test.mjs']);
  assert.deepEqual(await fs.readFile(canonical), before);
});

test('release-overlay regression reports the stale add-on suite without deleting it', async t => {
  const {root, retired} = await fixture(t);
  const content = '// obsolete expectation: openjev-llamacpp-addon\n';
  await fs.writeFile(retired, content);
  await assert.rejects(verifySourceLayout(root), error => {
    assert.match(error.message, /Obsolete standalone add-on suite/);
    assert.match(error.message, /tests\/openjev-sidecar\.test\.mjs/);
    assert.match(error.message, /git rm tests\/openjev-addon\.test\.mjs/);
    return true;
  });
  assert.equal(await fs.readFile(retired, 'utf8'), content);
});

test('source layout detects a dangling retired symlink without following it', async t => {
  const {root, retired} = await fixture(t);
  await fs.symlink('missing-target.mjs', retired);
  await assert.rejects(verifySourceLayout(root), /Obsolete standalone add-on suite/);
  assert.equal(await fs.readlink(retired), 'missing-target.mjs');
});

test('source layout cannot pass by deleting both OpenJev test suites', async t => {
  const {root, canonical} = await fixture(t);
  await fs.unlink(canonical);
  await assert.rejects(verifySourceLayout(root), /Missing canonical OpenJev sidecar test suite/);
});

for (const type of ['directory', 'symlink']) {
  test(`source layout rejects a ${type} in place of the canonical suite`, async t => {
    const {root, canonical} = await fixture(t);
    await fs.unlink(canonical);
    if (type === 'directory') await fs.mkdir(canonical);
    else await fs.symlink('missing-target.mjs', canonical);
    await assert.rejects(verifySourceLayout(root), /Missing canonical OpenJev sidecar test suite/);
  });
}

test('repository ships the canonical sidecar suite and no retired duplicate', async () => {
  assert.deepEqual(await verifySourceLayout(ROOT), {verified: true});
});
