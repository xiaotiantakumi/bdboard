import { describe, expect, it } from 'vitest';
import { MACHINE_CHECK_POSITION_LIMIT, runMachineChecks, truncateExternalIssue, type TextChecks } from './external-issue-checks.js';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime, type ScaleCount } from './linear-time-test-support.js';

// bdboard-4y8q.9.1: 届いた issue は他人が書いた任意長の文字列。機械の検査は切り詰めた後の文字列にかける (docs/ISSUE-REPORTING.md
// 8節。題名 300・本文 20,000 コードポイントまで) ので、実運用の入力は上限で止まるが、検査自体も入力の長さに線形でなければならない
// (上限を変えても、呼び出しの順が変わっても 2 乗に膨らまないこと)。ここでは上限を超える長さまで測る。
// 閉じない <!--、開きだけが並ぶ [ ](、宛先の閉じないリンクなどで膨らまないことを形ごとに見る。
// 形ごとに別のテストにして、1 つの形の 2 次を他の形の線形の時間に埋もれさせない。
// 期待値は実装を呼ばずに、形の作り方から出す (小・大のどちらの実行でも run の中で検査する)。
//
// 見えない文字は実行時に組む (ソースに直接書かない)。
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const EMOJI = String.fromCodePoint(0x1f600);
const TAG_A = String.fromCodePoint(0xe0041);

interface Shape {
  readonly name: string;
  /** 入力と、結果が満たすべきことの検査。 */
  readonly build: (n: ScaleCount) => { readonly text: string; readonly verify: (checks: TextChecks) => void };
}

const SHAPES: readonly Shape[] = [
  // --- 見えない文字 ---
  {
    name: 'a huge run of one invisible character',
    build: (n) => ({
      text: ZWSP.repeat(n(400_000)),
      verify: (checks) => {
        expect(checks.invisibleChars.total).toBe(n(400_000));
        expect(checks.invisibleChars.kinds[0]?.positions).toHaveLength(MACHINE_CHECK_POSITION_LIMIT);
      },
    }),
  },
  {
    name: 'alternating invisible characters between letters',
    build: (n) => ({
      text: `a${ZWSP}b${RLO}`.repeat(n(150_000)),
      verify: (checks) => {
        expect(checks.invisibleChars.total).toBe(2 * n(150_000));
        expect(checks.invisibleChars.kinds.map((kind) => kind.count)).toEqual([n(150_000), n(150_000)]);
      },
    }),
  },
  {
    name: 'a huge run of tag characters (surrogate pairs)',
    build: (n) => ({
      text: TAG_A.repeat(n(300_000)),
      verify: (checks) => {
        expect(checks.invisibleChars.total).toBe(n(300_000));
        expect(checks.invisibleChars.kinds[0]?.positions).toHaveLength(MACHINE_CHECK_POSITION_LIMIT);
      },
    }),
  },
  {
    name: 'astral characters that are not listed (emoji only)',
    build: (n) => ({ text: EMOJI.repeat(n(300_000)), verify: (checks) => expect(checks.invisibleChars.total).toBe(0) }),
  },
  // --- HTML コメント ---
  {
    name: 'one unclosed <!-- followed by a very long text',
    build: (n) => ({
      text: `<!--${'a'.repeat(n(1_000_000))}`,
      verify: (checks) => expect(checks.htmlComments).toMatchObject({ count: 1, unclosed: true, totalChars: n(1_000_000) + 4 }),
    }),
  },
  {
    name: 'many <!-- openers in a row (one unclosed comment)',
    build: (n) => ({
      text: '<!--'.repeat(n(250_000)),
      verify: (checks) => expect(checks.htmlComments).toMatchObject({ count: 1, unclosed: true, totalChars: 4 * n(250_000) }),
    }),
  },
  {
    name: 'many empty closed comments',
    build: (n) => ({
      text: '<!---->'.repeat(n(150_000)),
      verify: (checks) => {
        expect(checks.htmlComments).toMatchObject({ count: n(150_000), unclosed: false, totalChars: 7 * n(150_000) });
        expect(checks.htmlComments.spans).toHaveLength(MACHINE_CHECK_POSITION_LIMIT);
      },
    }),
  },
  {
    // <!-->x を並べると、各コメントは次の開きの末尾の `-->` で閉じる (自分の末尾では閉じない)。2 つで 1 件、11 文字。
    name: 'many <!--> openers, each comment closing at the tail of the next opener',
    build: (n) => ({
      text: '<!-->x'.repeat(n(150_000)),
      verify: (checks) => expect(checks.htmlComments).toMatchObject({ count: n(150_000) / 2, unclosed: false, totalChars: (11 * n(150_000)) / 2 }),
    }),
  },
  // --- 長い符号化文字列 ---
  {
    name: 'one huge run of encoded characters',
    build: (n) => ({
      text: 'A'.repeat(n(1_000_000)),
      verify: (checks) => expect(checks.longEncodedStrings).toMatchObject({ count: 1, longest: n(1_000_000) }),
    }),
  },
  {
    name: 'many runs just below the threshold',
    build: (n) => ({
      text: `${'A'.repeat(199)} `.repeat(n(5_000)),
      verify: (checks) => expect(checks.longEncodedStrings).toMatchObject({ count: 0, longest: 0 }),
    }),
  },
  {
    name: 'many runs exactly at the threshold',
    build: (n) => ({
      text: `${'A'.repeat(200)} `.repeat(n(5_000)),
      verify: (checks) => {
        expect(checks.longEncodedStrings).toMatchObject({ count: n(5_000), longest: 200 });
        expect(checks.longEncodedStrings.spans).toHaveLength(MACHINE_CHECK_POSITION_LIMIT);
      },
    }),
  },
  // --- リンク ---
  {
    name: 'many [ ]( openers with no closing parenthesis',
    build: (n) => ({
      text: '[](a'.repeat(n(200_000)),
      verify: (checks) => expect(checks.links.total).toBe(0),
    }),
  },
  {
    name: 'many [ ]( openers on separate lines (the closing parenthesis comes only at the very end)',
    build: (n) => ({
      text: `${'[](a\n'.repeat(n(150_000))})`,
      verify: (checks) => expect(checks.links.markdownLinks).toBe(0),
    }),
  },
  {
    name: 'only opening brackets',
    build: (n) => ({ text: '['.repeat(n(500_000)), verify: (checks) => expect(checks.links.total).toBe(0) }),
  },
  {
    name: 'only closing brackets',
    build: (n) => ({ text: ']('.repeat(n(300_000)), verify: (checks) => expect(checks.links.total).toBe(0) }),
  },
  {
    name: 'deeply nested brackets closed by many links',
    build: (n) => ({
      text: `${'['.repeat(n(100_000))}${'](x)'.repeat(n(100_000))}`,
      verify: (checks) => expect(checks.links.markdownLinks).toBe(n(100_000)),
    }),
  },
  {
    name: 'many short Markdown links',
    build: (n) => ({
      text: '[a](b) '.repeat(n(100_000)),
      verify: (checks) => expect(checks.links).toMatchObject({ total: n(100_000), markdownLinks: n(100_000) }),
    }),
  },
  {
    name: 'many autolink openers that never close',
    build: (n) => ({
      text: '<ab:'.repeat(n(200_000)),
      verify: (checks) => expect(checks.links.autolinks).toBe(0),
    }),
  },
  {
    name: 'many short autolinks',
    build: (n) => ({
      text: '<ab:x> '.repeat(n(100_000)),
      verify: (checks) => expect(checks.links).toMatchObject({ total: n(100_000), autolinks: n(100_000) }),
    }),
  },
  {
    name: 'one very long autolink-like scheme',
    build: (n) => ({ text: `<${'a'.repeat(n(1_000_000))}`, verify: (checks) => expect(checks.links.total).toBe(0) }),
  },
  {
    name: 'many raw URLs',
    build: (n) => ({
      text: 'https://a.example '.repeat(n(100_000)),
      verify: (checks) => expect(checks.links).toMatchObject({ total: n(100_000), rawUrls: n(100_000) }),
    }),
  },
  {
    name: 'one huge raw URL',
    build: (n) => ({
      text: `http://${'a'.repeat(n(1_000_000))}`,
      verify: (checks) => expect(checks.links).toMatchObject({ total: 1, rawUrls: 1 }),
    }),
  },
  {
    name: 'many reference definitions',
    build: (n) => ({
      text: '[x]: https://a.example\n'.repeat(n(100_000)),
      verify: (checks) => expect(checks.links).toMatchObject({ total: n(100_000), referenceDefinitions: n(100_000) }),
    }),
  },
  {
    name: 'a definition label that never closes, on one very long line',
    build: (n) => ({ text: `[${'a'.repeat(n(1_000_000))}`, verify: (checks) => expect(checks.links.total).toBe(0) }),
  },
  {
    name: 'a definition-like line followed by a very long run of spaces',
    build: (n) => ({ text: `[x]:${' '.repeat(n(1_000_000))}\nnext`, verify: (checks) => expect(checks.links.total).toBe(0) }),
  },
  {
    name: 'many [x]: lines with nothing after the colon',
    build: (n) => ({ text: '[x]:\n'.repeat(n(200_000)), verify: (checks) => expect(checks.links.total).toBe(0) }),
  },
  {
    name: 'one [ then many lines of raw URLs, closed by one ](x) at the end',
    build: (n) => ({
      text: `[\n${'https://a.example\n'.repeat(n(100_000))}](x)`,
      verify: (checks) => expect(checks.links).toMatchObject({ markdownLinks: 1, rawUrls: n(100_000) }),
    }),
  },
  {
    name: 'astral characters between link pieces',
    build: (n) => ({
      text: `[${EMOJI}](${EMOJI}) `.repeat(n(100_000)),
      verify: (checks) => expect(checks.links.markdownLinks).toBe(n(100_000)),
    }),
  },
];

describe('runMachineChecks: linear time on hostile content', () => {
  it.each(SHAPES)(
    'measures $name in time linear in its length',
    ({ name, build }) => {
      expectLinearTime(`external-issue-checks: ${name}`, (n) => {
        const { text, verify } = build(n);
        // `repeat` や連結で組んだ入力は連結文字列 (rope) で、最初の走査が平坦化 (1〜2MB のコピー) を負担する。実運用の本文は
        // 平坦な文字列で届くので、平坦化は計測に入る前に済ませる (bdboard-4367。計測するのは検査の増え方で、入力の組み立てではない)。
        text.charCodeAt(0);
        return () => {
          verify(runMachineChecks({ title: '', body: text }).body);
        };
      });
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});

describe('truncateExternalIssue: linear time on a very long input', () => {
  it('measures a huge body in time linear in its length', () => {
    expectLinearTime('external-issue-checks: truncate a huge body', (n) => {
      const body = `${'a'.repeat(n(2_000_000))}${EMOJI}`;
      return () => {
        const result = truncateExternalIssue({ title: 't', body });
        expect(result.bodyLength).toBe(n(2_000_000) + 1);
        expect(result.bodyTruncated).toBe(true);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('measures a huge body of astral characters in time linear in its length', () => {
    expectLinearTime('external-issue-checks: truncate a huge astral body', (n) => {
      const body = EMOJI.repeat(n(500_000));
      return () => {
        const result = truncateExternalIssue({ title: EMOJI.repeat(1_000), body });
        expect(result.bodyLength).toBe(n(500_000));
        expect(result.titleLength).toBe(1_000);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
