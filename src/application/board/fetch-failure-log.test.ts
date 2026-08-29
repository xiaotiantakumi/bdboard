import { describe, expect, it } from 'vitest';
import { describeFetchFailures } from './fetch-failure-log.js';

describe('describeFetchFailures (bdboard-fxxk)', () => {
  it('reports the count against the total attempted', () => {
    // 分母が無いと「全滅」と「1件だけ」が区別できない。
    expect(
      describeFetchFailures([{ id: 'bdboard-a', error: new Error('boom') }], 12),
    ).toBe('1 of 12 failed. First failure: bdboard-a: boom');
  });

  it('names only the first failure', () => {
    // 全部並べると、まとめて1行にした意味が無くなる。
    const message = describeFetchFailures(
      [
        { id: 'bdboard-a', error: new Error('first') },
        { id: 'bdboard-b', error: new Error('second') },
        { id: 'bdboard-c', error: new Error('third') },
      ],
      3,
    );

    expect(message).toContain('3 of 3 failed');
    expect(message).toContain('bdboard-a: first');
    expect(message).not.toContain('bdboard-b');
    expect(message).not.toContain('second');
  });

  it('falls back to String() for values that are not Errors', () => {
    // bd の失敗は BdError とは限らない。文字列や undefined が飛んできても
    // "[object Object]" 未満の情報にはしない。
    expect(describeFetchFailures([{ id: 'x', error: 'plain string' }], 1)).toBe(
      '1 of 1 failed. First failure: x: plain string',
    );
    expect(describeFetchFailures([{ id: 'x', error: undefined }], 1)).toBe(
      '1 of 1 failed. First failure: x: undefined',
    );
  });

  it('falls back to String() for an Error with an empty message', () => {
    // message が空の Error をそのまま使うと "x: " で終わって手掛かりが消える。
    expect(describeFetchFailures([{ id: 'x', error: new Error('') }], 1)).toBe(
      '1 of 1 failed. First failure: x: Error',
    );
  });

  it('omits the failure detail when the list is empty', () => {
    // 呼び出し側は空なら出さない約束だが、出しても壊れた文にはしない。
    expect(describeFetchFailures([], 5)).toBe('0 of 5 failed.');
  });
});
