import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_RELATIVE_PATH, skillInstallRelativePath } from '../../domain/harness-path.js';
import { createFsPackRegistry } from './fs-pack-registry.js';

/**
 * 注入マニフェスト (`.claude/bdboard-packs.json`, MANIFEST_RELATIVE_PATH) の
 * `version` / `files` が、ハーネスパック正本 (`harness/packs/bdboard-harness/`,
 * レジストリ経由) と同期していることを機械で固定する (bdboard-yp46)。
 *
 * `injected-pack-is-in-sync.test.ts` は「注入コピー (`.claude/skills/bdboard-harness/`)
 * の中身」を正本と比較する一方、マニフェストそのものは意図的に対象外としている
 * (常時稼働サーバーが実行時に version / injectedAt を自己修復して書き込むため、
 * 含めると偽陽性の常習犯になる、という同ファイルのコメント参照)。
 *
 * ここで見るのはその「対象外にした部分」— ただし `injectedAt` は除く。
 * `injectedAt` は注入時刻そのものであり同期不変条件を持たないが、`version` と
 * `files` はパック更新 PR で必ず追従されるべき値であり、これが古いまま残ると
 * bdboard-yp46 の症状 (サーバー起動時の自己修復で作業ツリーに恒常的な未コミット
 * 差分が生える) を再発させる。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const REPO_ROOT = path.resolve(PACKS_ROOT, '../..');
const PACK_NAME = 'bdboard-harness';

interface ManifestPackEntry {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly files?: unknown;
}

interface ManifestFile {
  readonly packs?: unknown;
}

function readManifestEntry(): ManifestPackEntry {
  const manifestAbsolute = path.join(REPO_ROOT, MANIFEST_RELATIVE_PATH);
  const content = readFileSync(manifestAbsolute, 'utf8');
  const parsed = JSON.parse(content) as ManifestFile;
  const packs = Array.isArray(parsed.packs) ? parsed.packs : [];

  const entry = packs.find(
    (raw): raw is ManifestPackEntry =>
      typeof raw === 'object' && raw !== null && (raw as ManifestPackEntry).name === PACK_NAME,
  );

  expect(entry, `${MANIFEST_RELATIVE_PATH} must contain an entry for "${PACK_NAME}"`).toBeDefined();
  return entry as ManifestPackEntry;
}

describe('injected pack manifest (.claude/bdboard-packs.json) is in sync with canonical pack', () => {
  it('records the same version as harness/packs/bdboard-harness/pack.json', async () => {
    const registry = createFsPackRegistry(PACKS_ROOT);
    const pack = await registry.getPack(PACK_NAME);
    expect(pack).toBeDefined();

    const entry = readManifestEntry();
    expect(
      entry.version,
      'manifest "version" must be bumped in the same PR that bumps pack.json "version"',
    ).toBe(pack!.version);
  });

  it('lists exactly the install paths the registry derives from the canonical pack files', async () => {
    const registry = createFsPackRegistry(PACKS_ROOT);
    const pack = await registry.getPack(PACK_NAME);
    expect(pack).toBeDefined();

    const expectedInstallPaths = pack!.files.map((file) => {
      const installPath = skillInstallRelativePath(PACK_NAME, file.relativePath);
      expect(installPath).not.toBeNull();
      return installPath!;
    });
    const expectedInstallPathSet = new Set(expectedInstallPaths);

    const entry = readManifestEntry();
    const recordedFiles = Array.isArray(entry.files)
      ? entry.files.filter((file): file is string => typeof file === 'string')
      : [];
    const recordedFileSet = new Set(recordedFiles);

    const onlyInCanonical = expectedInstallPaths.filter((p) => !recordedFileSet.has(p));
    const onlyInManifest = recordedFiles.filter((p) => !expectedInstallPathSet.has(p));

    expect(
      { onlyInCanonical, onlyInManifest },
      'manifest "files" must match registry-derived install paths (both directions) — a pack file add/remove must be reflected here in the same PR',
    ).toEqual({ onlyInCanonical: [], onlyInManifest: [] });
  });
});
