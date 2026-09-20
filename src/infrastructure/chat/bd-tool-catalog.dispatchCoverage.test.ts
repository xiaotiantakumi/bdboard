import { describe, expect, it } from 'vitest';
import { BD_TOOL_DEFINITIONS, buildBdToolArgs } from './bd-tool-catalog.js';

const PROJECT_ROOT = '/tmp/bdboard-test-project';

/**
 * bdboard-sso1.18 レビュー指摘(opus, nit): buildBdToolArgs は分割後、単一の switch から
 * 5つのグループ builder (buildReadToolArgs / buildLifecycleToolArgs / buildContentToolArgs /
 * buildScheduleLabelToolArgs / buildCreateDepToolArgs) を `??` チェーンで順に試す構成に
 * なった。挙動は移動元のまま (各 builder は自分が担当しない toolName に対して必ず
 * `undefined` を返し、19ツール名は5ファイルへ重複なく分割済み — レビューで1,224通りの
 * (toolName, payload) 差分テストにより検証済み) だが、その不変条件 (どの1ツールも
 * "unknown tool" へ取りこぼされない/2ファイルにまたがって二重定義されない) 自体を
 * 固定するテストが無かった。将来カタログにツールを追加したとき、対応する builder への
 * 登録を忘れると *その場では気づかれず* 静かに "unknown tool" 扱いになる (今のカタログでは
 * 発生していない — このテストはその将来の退行を防ぐガード)。
 */
describe('buildBdToolArgs dispatch coverage (bdboard-sso1.18 module split regression guard)', () => {
  it('handles every catalog tool name (none falls through to "unknown tool")', () => {
    for (const tool of BD_TOOL_DEFINITIONS) {
      const result = buildBdToolArgs(tool.name, {}, PROJECT_ROOT);
      if (!result.ok) {
        expect(result.error, `tool ${tool.name} was not handled by any group builder`).not.toMatch(
          /^unknown tool:/,
        );
      }
    }
  });

  it('still rejects a genuinely unknown tool name', () => {
    const result = buildBdToolArgs('bd_does_not_exist', {}, PROJECT_ROOT);
    expect(result).toEqual({ ok: false, error: 'unknown tool: bd_does_not_exist' });
  });
});
