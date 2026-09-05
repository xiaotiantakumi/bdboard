import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * bdboard-qti6 の回帰ガード。
 *
 * bdboard-68ub は `vh` に `dvh` を併記する規約 (dvh 非対応ブラウザ = Chrome <108 /
 * Safari <15.4 / Firefox <101 で `vh` 版へ落ちる) を全面適用したが、**逆向きの穴**が
 * 残っていた — `vh` フォールバックを持たない裸の `dvh` が index.css に 7 箇所。実害の
 * 例は `.bulk-action-bar { max-height: 70dvh }` (MINOR-6 のバグが非対応ブラウザで
 * 復活する)。bdboard-qti6 でこの 7 箇所を精査し、5 箇所 (実測は 6 箇所だった —
 * 下記「件数の補足」参照) は単純な 2 行併記で直し、残り 1 箇所
 * (`--chat-attachment-preview-size`) はカスタムプロパティ経由で単純併記が効かない
 * ため意図的に未対応のまま残してコメントで理由を明文化した (index.css の当該
 * 宣言直前のコメント、bdboard-qti6 参照)。
 *
 * このテストは「新規に増える裸の dvh」を機械的に検出する。dvh を含む宣言ごとに、
 * 同じ規則内で**直前の非空行**が同じプロパティの `vh` (dvh を含まない) 宣言であるかを
 * 見る。ブロック境界 (`{` / `}`) を跨いだ先は探さない — フォールバックは常に
 * 同一規則内の隣接 2 行として書く規約 (併記の順序は vh が先・dvh が後) だからで、
 * 別の規則の同名プロパティが偶然「前に」あっても正しいフォールバックにはならない。
 *
 * **件数の補足。** チケット本文はチケット起票時点 (2026-09-05) の行番号で 7 箇所・
 * 「単純併記 5 + custom property/clamp 経由 2」と記載していたが、実装時に自分で
 * 洗い出し直したところ 7 箇所という総数は変わらず、内訳が「単純併記 6 +
 * custom property 経由 1」だった。差分はチケットが `.chat-input-notices` の
 * `max-height: clamp(44px, calc(100dvh - 469px), 96px)` を custom property 経由の
 * 1 件として数えていた箇所で、実際には `clamp()` を直接 `max-height` (型付き
 * プロパティ) に書いているだけで custom property は介さない。`clamp()`/`min()` は
 * 引数に dvh があれば宣言全体がトップレベルの dvh 宣言と同じ規則で無効化される
 * (bdboard-68ub のレビューで実測確認済み — index.css:3840 等の既存 `min()` 併記と
 * 同型) ので、単純な 2 行併記がそのまま効く。custom property 経由で本当に単純併記が
 * 効かないのは `--chat-attachment-preview-size` (index.css の定義箇所コメント参照)
 * の 1 件だけだった。
 *
 * **このテストが保証しないこと。** dvh 対応ブラウザでの見た目・レイアウトの正しさは
 * 見ていない (それは実ブラウザでの確認や e2e の担当)。ここが守るのは「dvh を足す/
 * 変える編集が、意図せず vh フォールバックの併記を欠いたまま入る」経路だけ。
 */

const CSS_RELATIVE_PATH = './index.css';

/**
 * 単純な vh→dvh の 2 行併記では救えない (invalid-at-computed-value-time の
 * フォールバック不成立を起こす) と分かっている custom property。理由は
 * index.css の `--chat-attachment-preview-size: clamp(28px, calc(100dvh - 485px), 44px);`
 * 直前のコメント (bdboard-qti6) を参照。ここに載っている名前は「対処しないと決めた」
 * 明示的な allowlist であり、暗黙に見逃しているわけではない — 新しく裸の dvh が
 * 増えたときにこの名前でなければこのテストは必ず落ちる。
 */
const DVH_WITHOUT_FALLBACK_ALLOWLIST = new Set<string>([
  '--chat-attachment-preview-size',
]);

function readCss(): string {
  return readFileSync(fileURLToPath(new NodeUrl(CSS_RELATIVE_PATH, import.meta.url)), 'utf8');
}

/**
 * ブロックコメントの中身を改行以外すべて空白に置き換える。行番号をずらさずに
 * コメント中の「dvh」という語 (説明文によく出てくる) を宣言と誤認しないようにする。
 */
function blankCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const DVH_TOKEN_PATTERN = /\d+(?:\.\d+)?dvh\b/g;
const VH_TOKEN_PATTERN = /\d+(?:\.\d+)?vh\b/;
const PROPERTY_NAME_PATTERN = /^\s*(--[\w-]+|[a-zA-Z-]+)\s*:/;

/** dvh の数値トークンを取り除いた後にもなお (d の付かない) vh 単位が残っているか。 */
function hasPlainVh(line: string): boolean {
  return VH_TOKEN_PATTERN.test(line.replace(DVH_TOKEN_PATTERN, ''));
}

function propertyNameOf(line: string): string | null {
  const match = line.match(PROPERTY_NAME_PATTERN);
  return match ? match[1] : null;
}

interface NakedDvhFinding {
  lineNumber: number;
  line: string;
  reason: string;
}

/**
 * dvh を含む宣言のうち、同一規則内で直前に同じプロパティの vh フォールバックが
 * 無いものを列挙する。パースできない行 (dvh はあるがプロパティ名を取り出せない)
 * も findings に含める — 黙って見逃すより、走査ロジックの更新を要求して止める方が
 * 安全 (index.css.customProperties.test.ts の `unresolved` と同じ考え方)。
 */
function findNakedDvhDeclarations(css: string): NakedDvhFinding[] {
  const lines = blankCssComments(css).split('\n');
  const findings: NakedDvhFinding[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\ddvh\b/.test(line)) {
      continue;
    }

    const property = propertyNameOf(line);
    if (property === null) {
      findings.push({
        lineNumber: index + 1,
        line: line.trim(),
        reason: 'dvh を含む行からプロパティ名を取り出せませんでした (PROPERTY_NAME_PATTERN を更新してください)',
      });
      continue;
    }

    // 同じ規則内 (ブロック境界 { / } を跨がない) を上へ遡り、**同じプロパティの
    // 直近の宣言**を探す。CSS のカスケードは「同じプロパティなら後勝ち」なので、
    // 間に別プロパティの行が挟まっていても構わない (例: height/max-height を
    // vh 版 2 行→dvh 版 2 行の順に並べる書き方 — index.css:6808-6811)。直近の
    // 同名プロパティが vh のみ (dvh を含まない) ならフォールバックが効く。直近の
    // 同名プロパティ自体が dvh ならその宣言はさらに前を見ずに「フォールバック無し」
    // 確定 (それより前にあっても、直近の dvh 宣言がカスケードで勝つため無関係)。
    let hasFallback = false;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = lines[cursor];
      if (candidate.trim() === '') {
        continue;
      }
      if (candidate.includes('{') || candidate.includes('}')) {
        break;
      }
      const candidateProperty = propertyNameOf(candidate);
      if (candidateProperty !== property) {
        continue;
      }
      hasFallback = hasPlainVh(candidate) && !/\ddvh\b/.test(candidate);
      break;
    }

    if (!hasFallback && !DVH_WITHOUT_FALLBACK_ALLOWLIST.has(property)) {
      findings.push({
        lineNumber: index + 1,
        line: line.trim(),
        reason: `プロパティ "${property}" の直前に vh フォールバックがありません`,
      });
    }
  }

  return findings;
}

describe('index.css — dvh には vh フォールバックを併記する (bdboard-68ub / bdboard-qti6)', () => {
  it('裸の dvh (vh フォールバック無し、または allowlist 外) が無い', () => {
    const findings = findNakedDvhDeclarations(readCss());
    expect(
      findings,
      findings
        .map((f) => `  index.css:${f.lineNumber}: ${f.line}  — ${f.reason}`)
        .join('\n') ||
        undefined,
    ).toEqual([]);
  });

  it('allowlist は実在する dvh 宣言だけを載せている (陳腐化検出)', () => {
    const css = blankCssComments(readCss());
    const stale = [...DVH_WITHOUT_FALLBACK_ALLOWLIST].filter(
      (property) => !css.includes(`${property}:`) || !new RegExp(`${property}\\s*:[^;]*\\ddvh\\b`).test(css),
    );
    expect(
      stale,
      `DVH_WITHOUT_FALLBACK_ALLOWLIST に、もう dvh を裸で使っていないエントリがあります: ${stale.join(', ')}。vh フォールバックが足された、または宣言自体が消えたなら allowlist から削除してください。`,
    ).toEqual([]);
  });
});
