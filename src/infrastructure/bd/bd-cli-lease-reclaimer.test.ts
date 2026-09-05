import { describe, expect, it } from 'vitest';
import { buildReclaimArgs } from './bd-cli-lease-reclaimer.js';

describe('buildReclaimArgs', () => {
  it('reclaims the whole project when no ids are given', () => {
    expect(buildReclaimArgs('/repo', '2h')).toEqual([
      '-C',
      '/repo',
      'reclaim',
      '--older-than',
      '2h',
    ]);
  });

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
  // 「1件も回収しない」のつもりで渡すと真逆になるので、ここで意味が変わって
  // いないことを固定する (呼び出し側は空なら bd を呼ばない — reclaim-scheduler)。
  it('an empty id list produces the SAME command as no ids at all', () => {
    expect(buildReclaimArgs('/repo', '2h', [])).toEqual(buildReclaimArgs('/repo', '2h'));
  });
});
