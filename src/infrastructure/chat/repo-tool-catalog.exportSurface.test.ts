import { describe, expect, it } from 'vitest';
import * as repoToolCatalog from './repo-tool-catalog.js';

/**
 * bdboard-sso1.71: src/infrastructure/chat/repo-tool-catalog.ts を機能別モジュール
 * (./repo-tool-catalog/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の repo-tool-catalog.ts) から
 * `grep -nE '^export ' src/infrastructure/chat/repo-tool-catalog.ts` で機械的に
 * 採取した値エクスポート名 (6件) をそのままハードコードしている
 * (ai-quota-source.ts 分割 #605 の方式)。
 *
 * 型エクスポート (RepoToolName / RepoOutputFilter / RepoArgsBuildResult) はここでは
 * 検証できないため、repo-tool-catalog-type-export-surface.check.ts (dto.ts 分割 #540 の
 * 方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = [
  'REPO_TOOL_NAMES',
  'isRepoToolName',
  'REPO_TOOL_DEFINITIONS',
  'REPO_DEFAULT_REF',
  'buildRepoToolArgs',
  'applyRepoOutputFilter',
].sort();

describe('repo-tool-catalog.ts export surface (bdboard-sso1.71 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(repoToolCatalog).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
