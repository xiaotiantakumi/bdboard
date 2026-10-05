import { describe, expect, it } from 'vitest';
import { codeBlock, codeSpan } from './issue-public-markdown.js';
import { elide, type RedactedText, type TextMark } from './issue-public-redact.js';
import {
  LINEAR_TIME_TEST_TIMEOUT_MS,
  MIN_SAMPLE_MS,
  expectLinearTime,
  type LinearTimeOptions,
  type ScaleCount,
} from './linear-time-test-support.js';

// bdboard-ncbb (PR #890 のレビュー MINOR-3 の残り): codeSpan / codeBlock (issue-public-markdown.ts) と elide
// (issue-public-redact.ts) の線形時間を、1 つずつ・切り詰めない入力で検査する。
//
// issue-public-build.test.ts の線形テストは buildPublicIssueBody 全体を測る。codeSpan / codeBlock が受け取るのは、
// 置換して欄の上限 (8000 / 1000 / 80 / 120 コードポイント) で切った後の文字列なので、build の比には入力の長さへの伸び方が
// 出ない (サイズに依らない遅さは比に現れない)。elide は切る前の全文を受け取るが、build の時間の大半は置換の探索なので、
// elide の 2 次はその時間に埋もれる。ここでは build の上限にかからない長さ (小の実行でも 10k 文字以上で、head の 8000 を
// 超える) を直接渡す。
// 形ごとに別のテストにするのは、1 つの形の 2 次を他の形の線形の時間に埋もれさせないため (比は合計で見る)。
//
// 入力は敵対的な形: バッククォートの長い連なり・短い連なりの繰り返し・長さが増えていく連なり・閉じないコードフェンス・
// 長い行・多数の短い行・多数の短い span・多数の印・多数の「避ける範囲」。内容の検査は run の中に置く
// (小・大のどちらでも走る。期待値は実装を呼ばずに、形の作り方と CommonMark の規則から出す)。

// 孤立サロゲートは実行時に組み立てる (他のテストと同じ)。
const HIGH = String.fromCharCode(0xd83d);
const NO_MARKS: readonly TextMark[] = [];

// many marks は 1 回の呼び出しで 10 万個の印のオブジェクトを作る (約 15ms)。30ms のサンプルには 2 回分しか入らず、GC が入るかどうかで
// 1 回あたりが 11ms と 40ms に割れて、正しいコードでも比が 7〜42 に散る (PR #897 のレビューの実測。31 回中 1 回は 3 試行とも 31.5 で落ちた)。
// サンプルを 200ms 以上にして GC を平均に含める (20 回で初回の比が 15.4 以下)。Windows は既定の 160ms より少し長いだけ。
const ALLOCATING: LinearTimeOptions = { minSampleMs: Math.max(MIN_SAMPLE_MS, 200) };

/** 内容と、その中のバッククォートの連なりの最長 (形の作り方から分かる値で、実装を呼んで出さない)。 */
interface Content {
  readonly text: string;
  readonly longestRun: number;
}

interface Shape {
  readonly name: string;
  readonly build: (n: ScaleCount) => Content;
}

/** 1, 2, 3, … 個の連なりを `a` で区切って並べ、合計が length に届くまで続ける (連なりの数は length の平方根のオーダー)。 */
function ascendingRuns(length: number): Content {
  let text = '';
  let run = 0;
  while (text.length < length) {
    run += 1;
    text += '`'.repeat(run) + 'a';
  }
  return { text, longestRun: run };
}

/** codeSpan と codeBlock のどちらにも渡す形。 */
const BACKTICK_SHAPES: readonly Shape[] = [
  { name: 'one huge run of backticks', build: (n) => ({ text: '`'.repeat(n(100_000)), longestRun: n(100_000) }) },
  { name: 'many runs of one backtick', build: (n) => ({ text: '`a'.repeat(n(150_000)), longestRun: 1 }) },
  { name: 'many runs of two backticks', build: (n) => ({ text: '``a'.repeat(n(100_000)), longestRun: 2 }) },
  { name: 'runs of growing length', build: (n) => ascendingRuns(n(200_000)) },
  { name: 'one very long line without a backtick', build: (n) => ({ text: 'a'.repeat(n(1_000_000)), longestRun: 0 }) },
  { name: 'astral characters between backticks', build: (n) => ({ text: '😀`'.repeat(n(100_000)), longestRun: 1 }) },
];

/** codeBlock だけに渡す形: 閉じないフェンスと、行の多い入力。 */
const BLOCK_SHAPES: readonly Shape[] = [
  { name: 'unclosed fences, one after another', build: (n) => ({ text: '```text\n'.repeat(n(40_000)), longestRun: 3 }) },
  { name: 'one unclosed fence with a very long info line', build: (n) => ({ text: '```' + 'a'.repeat(n(1_000_000)), longestRun: 3 }) },
  { name: 'many short lines', build: (n) => ({ text: 'line\n'.repeat(n(200_000)), longestRun: 0 }) },
  { name: 'a backtick on every line', build: (n) => ({ text: '`\n'.repeat(n(200_000)), longestRun: 1 }) },
];

// 出力の長さ: 区切りの長さ (最長の連なり + 1。フェンスは 3 以上) と、コードスパンの前後の空白 (内容がバッククォートで
// 始まる・終わるとき) から出す。
const spanLength = ({ text, longestRun }: Content): number =>
  text.length + 2 * (longestRun + 1) + (text.startsWith('`') || text.endsWith('`') ? 2 : 0);
// フェンス + "text\n" + 内容 + "\n" + フェンス。
const blockLength = ({ text, longestRun }: Content): number => text.length + 2 * Math.max(3, longestRun + 1) + 'text\n'.length + '\n'.length;

/** "ab<token>" を count 個並べた文字列と、その中の印 (1 つ 9 文字のうち後ろ 7 文字)。 */
function markedText(count: number): { text: string; marks: TextMark[] } {
  const marks: TextMark[] = [];
  for (let index = 0; index < count; index += 1) marks.push({ kind: 'token', start: index * 9 + 2, end: index * 9 + 9 });
  return { text: 'ab<token>'.repeat(count), marks };
}

/** 省略した数を入れる固定の文言 (build の label と同じく、長さが数字の桁数で決まる)。 */
const label = (omitted: number): string => `…(${String(omitted)})…`;

describe('codeSpan: linear time on hostile content', () => {
  it.each(BACKTICK_SHAPES)(
    'measures $name in time linear in its length',
    ({ name, build }) => {
      expectLinearTime(`issue-public-markdown codeSpan: ${name}`, (n) => {
        const content = build(n);
        const expected = spanLength(content);
        return () => {
          expect(codeSpan({ text: content.text, marks: NO_MARKS }).text.length).toBe(expected);
        };
      });
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );

  // 区切りの長さと前後の空白は span ごとに決まる (1 つの span の文字列は短いので、span の数に比例して伸びるはず)。
  // 内容は 1 つずつ別の文字列 (記憶して探す実装は、同じ内容の繰り返しでは気づけない)。
  it('wraps many short spans, each with its own delimiter, in time linear in their number', () => {
    const forms: readonly { readonly make: (index: number) => string; readonly overhead: number }[] = [
      { make: (index) => `a${String(index)}`, overhead: 2 }, // 区切り 1 + 1
      { make: (index) => `\`${String(index)}`, overhead: 6 }, // 連なり 1: 区切り 2 + 2、バッククォートで始まるので内側に空白 2
      { make: (index) => `x\`\`${String(index)}`, overhead: 6 }, // 連なり 2: 区切り 3 + 3
      { make: (index) => `${String(index)}\``, overhead: 6 }, // 連なり 1、バッククォートで終わる
    ];
    expectLinearTime('issue-public-markdown codeSpan: many short spans', (n) => {
      const texts: string[] = [];
      let expected = 0;
      for (let index = 0; index < n(60_000); index += 1) {
        const form = forms[index % forms.length];
        if (form === undefined) throw new Error('unreachable');
        const text = form.make(index);
        texts.push(text);
        expected += text.length + form.overhead;
      }
      return () => {
        let total = 0;
        for (const text of texts) total += codeSpan({ text, marks: NO_MARKS }).text.length;
        expect(total).toBe(expected);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('shifts many marks in time linear in their number', () => {
    expectLinearTime('issue-public-markdown codeSpan: many marks', (n) => {
      const input = markedText(n(100_000));
      return () => {
        const piece = codeSpan(input);
        // 区切りは 1 文字。最後の印は、元の位置より 1 つ後ろ。
        expect(piece.marks).toHaveLength(input.marks.length);
        expect(piece.marks.at(-1)?.start).toBe((input.marks.at(-1)?.start ?? 0) + 1);
      };
    }, ALLOCATING);
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});

describe('codeBlock: linear time on hostile content', () => {
  it.each([...BACKTICK_SHAPES, ...BLOCK_SHAPES])(
    'measures $name in time linear in its length',
    ({ name, build }) => {
      expectLinearTime(`issue-public-markdown codeBlock: ${name}`, (n) => {
        const content = build(n);
        const expected = blockLength(content);
        return () => {
          expect(codeBlock({ text: content.text, marks: NO_MARKS }).text.length).toBe(expected);
        };
      });
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );

  it('wraps many short blocks, each with its own fence, in time linear in their number', () => {
    const forms: readonly { readonly make: (index: number) => string; readonly overhead: number }[] = [
      { make: (index) => `a${String(index)}`, overhead: 12 }, // フェンス 3 x 2 + "text\n" + "\n"
      { make: (index) => `\`\`\`${String(index)}`, overhead: 14 }, // 連なり 3: フェンス 4
      { make: (index) => `x\n\`\`${String(index)}`, overhead: 12 }, // 連なり 2: フェンスは最小の 3
      { make: (index) => `${String(index)}\n\``, overhead: 12 },
    ];
    expectLinearTime('issue-public-markdown codeBlock: many short blocks', (n) => {
      const texts: string[] = [];
      let expected = 0;
      for (let index = 0; index < n(60_000); index += 1) {
        const form = forms[index % forms.length];
        if (form === undefined) throw new Error('unreachable');
        const text = form.make(index);
        texts.push(text);
        expected += text.length + form.overhead;
      }
      return () => {
        let total = 0;
        for (const text of texts) total += codeBlock({ text, marks: NO_MARKS }).text.length;
        expect(total).toBe(expected);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('shifts many marks in time linear in their number', () => {
    expectLinearTime('issue-public-markdown codeBlock: many marks', (n) => {
      const input = markedText(n(100_000));
      return () => {
        const piece = codeBlock(input);
        // フェンス 3 + "text\n" = 8 文字ずれる。
        expect(piece.marks).toHaveLength(input.marks.length);
        expect(piece.marks.at(-1)?.start).toBe((input.marks.at(-1)?.start ?? 0) + 8);
      };
    }, ALLOCATING);
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});

interface ElideCase {
  readonly name: string;
  /** 繰り返す 1 単位。 */
  readonly unit: string;
  readonly count: number;
  /** build が使う上限 (自由記述 8000 / エラー端 1000 + 1000 / 1 行の値 80)。 */
  readonly head: number;
  readonly tail: number;
}

const ELIDE_CASES: readonly ElideCase[] = [
  { name: 'ASCII text cut to the head only (free text: 8000)', unit: 'a', count: 1_000_000, head: 8_000, tail: 0 },
  { name: 'ASCII text cut to head and tail (error text: 1000 + 1000)', unit: 'a', count: 1_000_000, head: 1_000, tail: 1_000 },
  { name: 'astral text cut to the head only (inline value: 80)', unit: '😀', count: 500_000, head: 80, tail: 0 },
  { name: 'lone surrogates cut to the tail only', unit: HIGH, count: 1_000_000, head: 0, tail: 1_000 },
  { name: 'many short lines cut to the head only', unit: 'line\n', count: 200_000, head: 8_000, tail: 0 },
];

describe('elide: linear time on long text that the build would have cut', () => {
  it.each(ELIDE_CASES)(
    'cuts $name in time linear in its length',
    ({ name, unit, count, head, tail }) => {
      const pointsPerUnit = Array.from(unit).length;
      const unitsPerPoint = unit.length / pointsPerUnit;
      expectLinearTime(`issue-public-redact elide: ${name}`, (n) => {
        const text = unit.repeat(n(count));
        const omitted = n(count) * pointsPerUnit - head - tail;
        const expected = (head + tail) * unitsPerPoint + label(omitted).length;
        const redacted: RedactedText = { text, marks: NO_MARKS };
        return () => {
          expect(elide(redacted, head, tail, label).text.length).toBe(expected);
        };
      });
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );

  it('cuts text with many marks in time linear in their number, moving the cuts out of the marks', () => {
    expectLinearTime('issue-public-redact elide: many marks', (n) => {
      const count = n(100_000);
      const redacted = markedText(count);
      // 1 単位 9 文字 ("ab<token>" の印は後ろの 7 文字)。head 8000 は 888 番目の印 [7994, 8001) の内側なので 7994 へ戻る
      // (その前の印は 888 個)。tail 1000 の切れ目 9 * count - 1000 も印の内側で、印の終わり 9 * count - 999 へ進む
      // (その後ろの印は 111 個)。省略するのはその間。
      const headEnd = 7_994;
      const tailStart = 9 * count - 999;
      const expectedLength = headEnd + label(tailStart - headEnd).length + (9 * count - tailStart);
      return () => {
        const result = elide(redacted, 8_000, 1_000, label);
        expect(result.text.length).toBe(expectedLength);
        expect(result.marks).toHaveLength(888 + 111);
      };
    }, ALLOCATING);
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('cuts text with many separate ranges to avoid, handed over in reverse order', () => {
    expectLinearTime('issue-public-redact elide: many separate ranges to avoid', (n) => {
      const count = n(100_000);
      const text = 'a'.repeat(10 * count);
      // 範囲 [10i - 2, 10i + 2) (i = 1 .. count - 1)。head 8000 は i = 800 の [7998, 8002) の内側で 7998 へ戻り、
      // tail 1000 の切れ目 10 * count - 1000 は i = count - 100 の範囲の内側で、その終わり 10 * count - 998 へ進む。
      const ranges: { start: number; end: number }[] = [];
      for (let index = count - 1; index >= 1; index -= 1) ranges.push({ start: 10 * index - 2, end: 10 * index + 2 });
      const headEnd = 7_998;
      const tailStart = 10 * count - 998;
      const expectedLength = headEnd + label(tailStart - headEnd).length + (10 * count - tailStart);
      const redacted: RedactedText = { text, marks: NO_MARKS };
      return () => {
        expect(elide(redacted, 8_000, 1_000, label, () => ranges).text.length).toBe(expectedLength);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);

  it('cuts text with a chain of overlapping ranges to avoid, handed over in a scrambled order', () => {
    expectLinearTime('issue-public-redact elide: a chain of overlapping ranges to avoid', (n) => {
      const count = n(100_000);
      const text = 'a'.repeat(5 * count + 100);
      // 範囲 [5i, 5i + 8) は隣と重なり、和集合は [0, 5 * count + 3) の 1 つになる。head・tail の切れ目はどちらもその内側なので、
      // head は 0 へ戻り、tail は 5 * count + 3 へ進む。順序は 7919 (count と互いに素) 刻みで混ぜる。
      const ranges: { start: number; end: number }[] = [];
      for (let index = 0; index < count; index += 1) {
        const slot = (index * 7_919) % count;
        ranges.push({ start: 5 * slot, end: 5 * slot + 8 });
      }
      const unionEnd = 5 * (count - 1) + 8;
      const expectedLength = label(unionEnd).length + (text.length - unionEnd);
      const redacted: RedactedText = { text, marks: NO_MARKS };
      return () => {
        expect(elide(redacted, 8_000, 1_000, label, () => ranges).text.length).toBe(expectedLength);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
