import { describe, expect, it } from 'vitest';
import * as jsonlTranscriptScanner from './jsonl-transcript-scanner.js';

/**
 * bdboard-sso1.72: src/infrastructure/transcript/jsonl-transcript-scanner.ts を機能別モジュール
 * (./jsonl-transcript-scanner/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の jsonl-transcript-scanner.ts) から
 * `grep -nE '^export ' src/infrastructure/transcript/jsonl-transcript-scanner.ts` で機械的に
 * 採取した値エクスポート名 (1件) をそのままハードコードしている
 * (ps-process-scanner.ts 分割 #611 の方式)。
 *
 * 型エクスポートは分割前のファイルに存在しない (ScannerOptions / TargetMeta /
 * TargetWithProject はいずれも export されていないモジュール内部専用の型) ため、
 * type-export-surface.check.ts は不要。
 */
const EXPECTED_VALUE_EXPORTS = ['createJsonlTranscriptScanner'].sort();

describe('jsonl-transcript-scanner.ts export surface (bdboard-sso1.72 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(jsonlTranscriptScanner).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
