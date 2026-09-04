import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { skillInstallRelativePath } from '../../domain/harness-path.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { isHookScript } from './fs-harness-injector.js';
import { createFsPackRegistry } from './fs-pack-registry.js';

/**
 * ハーネスパック正本 (`harness/packs/bdboard-harness/`) と、git 追跡済みの注入コピー
 * (`.claude/skills/bdboard-harness/`) が同期していることを機械で固定する。
 *
 * 注入対象ファイルの集合は fs-pack-registry の `getPack('bdboard-harness').files` が
 * 唯一の根拠。`pack.json` はレジストリが走査時にスキップするため、ここでも比較対象外。
 *
 * `.claude/bdboard-packs.json` (MANIFEST_RELATIVE_PATH) はパックの中身ではなく注入マニフェスト。
 * レジストリは `harness/packs/bdboard-harness/` 配下しか走査しないので比較集合に入らない。
 * 常時稼働サーバーが実行時に version / injectedAt を自己修復して git 差分を生むことがある
 * (bdboard-8okb) ため、仮にここへ含めると偽陽性の常習犯になる。
 *
 * mode 検証は注入コピー (`.claude/skills/bdboard-harness/`) のみ。正本側の git mode は見ない。
 * 実行ビットは copyPackFile() が注入時に chmod 0o755 で付与するものであり、正本から引き継がれない。
 * よって正本の mode は同期不変条件の一部ではない。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const REPO_ROOT = path.resolve(PACKS_ROOT, '../..');
const PACK_NAME = 'bdboard-harness';
const CANONICAL_PACK_DIR = path.join(PACKS_ROOT, PACK_NAME);
const INJECTED_PACK_DIR = path.join(REPO_ROOT, '.claude', 'skills', PACK_NAME);

const runner = new NodeCommandRunner();

function collectFilesRecursively(
  directory: string,
  currentRelative = '',
): readonly string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath =
      currentRelative.length === 0 ? entry.name : path.posix.join(currentRelative, entry.name);
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFilesRecursively(absolutePath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  files.sort();
  return files;
}

function sha256Hex(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** `git ls-files -s` の 1 行から indexed mode (先頭フィールド) を取り出す。 */
function parseGitLsFilesLine(line: string): { readonly mode: string; readonly filePath: string } | null {
  const tabIndex = line.indexOf('\t');
  if (tabIndex === -1) {
    return null;
  }

  const meta = line.slice(0, tabIndex);
  const filePath = line.slice(tabIndex + 1);
  const mode = meta.split(' ')[0];
  if (mode === undefined || mode.length === 0 || filePath.length === 0) {
    return null;
  }

  return { mode, filePath };
}

async function readGitIndexedModes(repoRoot: string): Promise<Map<string, string>> {
  const result = await runner.run(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      'ls-files',
      '-s',
      '--',
      path.posix.join('.claude/skills', PACK_NAME),
    ],
    { cwd: repoRoot, timeoutMs: 20_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }

  const modes = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) {
      continue;
    }

    const parsed = parseGitLsFilesLine(line);
    if (parsed !== null) {
      modes.set(parsed.filePath, parsed.mode);
    }
  }

  return modes;
}

describe('injected bdboard-harness pack is in sync with canonical source', () => {
  it('matches path set, content hash, and injected git mode against injector expectations', async () => {
    const registry = createFsPackRegistry(PACKS_ROOT);
    const pack = await registry.getPack(PACK_NAME);

    expect(pack).toBeDefined();
    expect(pack!.files.length).toBeGreaterThan(0);

    const expectedInstallPaths = pack!.files.map((file) => {
      const installPath = skillInstallRelativePath(PACK_NAME, file.relativePath);
      expect(installPath).not.toBeNull();
      return installPath!;
    });
    const expectedInstallPathSet = new Set(expectedInstallPaths);

    const injectedPackRelativePaths = collectFilesRecursively(INJECTED_PACK_DIR);
    const actualInstallPaths = injectedPackRelativePaths.map((relativePath) => {
      const installPath = skillInstallRelativePath(PACK_NAME, relativePath);
      expect(installPath).not.toBeNull();
      return installPath!;
    });
    const actualInstallPathSet = new Set(actualInstallPaths);

    const onlyInCanonical = expectedInstallPaths.filter((p) => !actualInstallPathSet.has(p));
    const onlyInInjected = actualInstallPaths.filter((p) => !expectedInstallPathSet.has(p));

    expect(
      { onlyInCanonical, onlyInInjected },
      'injected copy path set must match registry-derived install paths (both directions)',
    ).toEqual({ onlyInCanonical: [], onlyInInjected: [] });

    const gitModes = await readGitIndexedModes(REPO_ROOT);
    const hashMismatches: string[] = [];
    const modeMismatches: string[] = [];

    for (const file of pack!.files) {
      const canonicalAbsolute = path.join(CANONICAL_PACK_DIR, file.relativePath);
      const installRelative = skillInstallRelativePath(PACK_NAME, file.relativePath)!;
      const injectedAbsolute = path.join(REPO_ROOT, installRelative);

      const canonicalHash = sha256Hex(canonicalAbsolute);
      const injectedHash = sha256Hex(injectedAbsolute);
      if (canonicalHash !== injectedHash) {
        hashMismatches.push(file.relativePath);
      }

      const injectedMode = gitModes.get(installRelative);
      const expectedMode = isHookScript(file.relativePath) ? '100755' : '100644';

      if (injectedMode !== expectedMode) {
        modeMismatches.push(
          `${file.relativePath}: injected=${injectedMode ?? 'missing'}, expected=${expectedMode}`,
        );
      }
    }

    expect(hashMismatches, 'content hash mismatches (canonical vs injected)').toEqual([]);
    expect(modeMismatches, 'git mode mismatches (injected vs injector expectation)').toEqual([]);
  });
});
