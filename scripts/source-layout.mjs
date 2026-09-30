/** Detect stale files left by overlaying a release ZIP on the standalone add-on. */
import fs from 'node:fs/promises';
import path from 'node:path';

async function statOrMissing(file) {
  try {
    // lstat also detects a dangling symlink; do not follow or modify it.
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function verifySourceLayout(root) {
  const retired = 'tests/openjev-addon.test.mjs';
  const canonical = 'tests/openjev-sidecar.test.mjs';
  if (await statOrMissing(path.join(root, retired))) {
    throw new Error(
      `Obsolete standalone add-on suite: ${retired}. ` +
      `Its 57 scenarios are maintained in ${canonical}. ` +
      'Review and remove the retired file (git rm tests/openjev-addon.test.mjs); ' +
      'extracting a release ZIP over an old checkout does not delete retired files.'
    );
  }
  const current = await statOrMissing(path.join(root, canonical));
  if (!current?.isFile()) {
    throw new Error(`Missing canonical OpenJev sidecar test suite: ${canonical}`);
  }
  return {verified: true};
}
