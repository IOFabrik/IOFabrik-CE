import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./generate-windows-version-info.mjs', import.meta.url));
test('Windows version metadata matches the selected build version and preserves identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iofabrik-version-'));
  try {
    const input = join(dir, 'template.json');
    const output = join(dir, 'output folder', 'info.json');
    const template = { fixed: { file_version: 'v0.0.1' }, info: { '0000': { CompanyName: 'IOFabrik', ProductVersion: 'v0.0.1' } } };
    await writeFile(input, JSON.stringify(template));
    for (const [version, numeric, product] of [
      ['v0.0.2', '0.0.2.0', '0.0.2'], ['1.2.3', '1.2.3.0', '1.2.3'],
      ['0.0.0-dev', '0.0.0.0', '0.0.0-dev'],
    ]) {
      const result = spawnSync(process.execPath, [script, version, input, output]);
      assert.equal(result.status, 0, result.stderr.toString());
      const actual = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(actual.fixed.file_version, numeric);
      assert.equal(actual.info['0000'].ProductVersion, product);
      assert.equal(actual.info['0000'].CompanyName, 'IOFabrik');
    }
    assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), template);
    for (const version of ['invalid', '1.2', '01.2.3', '65536.0.0']) {
      assert.notEqual(spawnSync(process.execPath, [script, version, input, output]).status, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
