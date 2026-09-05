import { describe, expect, it } from 'vitest';
import { buildReclaimArgs } from './bd-cli-lease-reclaimer.js';

describe('buildReclaimArgs', () => {
  it('narrows to the given ids with a repeated --id flag', () => {
    expect(buildReclaimArgs('/repo', '2h', ['bdboard-a', 'bdboard-b'])).toEqual([
      '-C',
      '/repo',
      'reclaim',
      '--older-than',
      '2h',
      '--id',
      'bdboard-a',
      '--id',
      'bdboard-b',
    ]);
  });

  // **`--id` を1つも付けないコマンドは「全件対象」を意味する。** 空配列を
  // 「1件も回収しない」のつもりで渡すと真逆になるので、黙って組み立てずに落とす。
  // 型 (NonEmptyTicketIds) でも塞いであるが、`as unknown as` や JS 経由の呼び出しは
  // 型を素通りするため、実行時のガードを外すとこのテストが落ちる。
  it('refuses an empty id list instead of widening to the whole project', () => {
    expect(() => buildReclaimArgs('/repo', '2h', [])).toThrow(/whole project/);
  });
});
