import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BD_TOOL_DEFINITIONS } from './bd-tool-catalog.js';

/**
 * bdboard-sso1.18: bd-tool-catalog.ts をツール群別モジュールへ分割するにあたっての
 * 事前ガード。BD_TOOL_DEFINITIONS は AI (チャットエージェント) へ渡るプロンプトの一部
 * であり、カタログ内のツールの並び順・各ツールの name / description / inputSchema が
 * 1文字でも変わるとモデルの挙動が変わりうる。
 *
 * このテストは分割に着手する**前**に、分割前の bd-tool-catalog.ts から
 * `createHash('sha256').update(JSON.stringify(BD_TOOL_DEFINITIONS)).digest('hex')`
 * (このテストと同じ式)の値を採取して固定したもの。分割後もこのハッシュが変わらず
 * 通ることで、移動のみ (内容・順序無変更) であったことを機械的に保証する。
 * (注意: シェル経由で `console.log` 出力を `sha256sum` に通すと末尾改行が混入し
 * 値がずれる。採取は必ずこのテストと同じ Node の crypto 呼び出しで行うこと。)
 *
 * ハッシュが変わったら、それは分割の副作用でカタログの内容/順序が変わったことを意味する
 * — 意図した変更でない限り、分割元の並びに戻すこと。
 */
const EXPECTED_CATALOG_SHA256 =
  '92fdc560c8c107675033bfa556f249eab937039c4c757d26280dd5a322073fd2';

describe('BD_TOOL_DEFINITIONS catalog content (bdboard-sso1.18 module split regression guard)', () => {
  it('is byte-identical (order, name, description, inputSchema, writes) to the pre-split catalog', () => {
    const json = JSON.stringify(BD_TOOL_DEFINITIONS);
    const hash = createHash('sha256').update(json).digest('hex');
    expect(hash).toBe(EXPECTED_CATALOG_SHA256);
  });
});
