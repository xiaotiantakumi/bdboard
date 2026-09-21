// bdboard-ekj3: 「閉じない `(`」を含むコミットメッセージを、書いた瞬間に弾く PreToolUse(Bash) ガード。
//
// 背景: release-please が使う @conventional-commits/parser は、直前の語にくっついた `(`
// (`採った(縦積み` のような形) をスコープの開始として読む。対応する `)` が同じ行に来ないと
// PEG が改行で落ち、そのコミットは CHANGELOG から黙って消える。タグを切ると永久に戻らない
// (詳細は scripts/check-commit-parse.mjs の冒頭)。開き括弧の前に半角スペースが 1 つあれば
// スコープとして読まれないので落ちない — つまり著者からは何が違うのか見えない罠である。
//
// この規約が今までどこにあったか: AGENTS.md にも CLAUDE.md にも docs/VERIFY.md にも無く、
// check-commit-parse.mjs が失敗時に出す実行時文字列と bd memory
// (2026-09-04-bdboard-commit-msg-paren-newline) にしかなかった。つまり「破ってから初めて
// 読む」文章で、規律として最初から弱い。その状態で 59498fa が main に入っている。
//
// このフックが見ているもの (CI の 2 層との違い):
//   - `npm run check:commits` (main push): タグ以降の main。**squash 後の 1 コミット**しか見ない。
//   - 同 PR 分岐 (bdboard-qhsb): base..head。ただし **CHANGELOG 対象の type だけ** を失敗に
//     する設計なので、59498fa のような test(...) は warning 止まりで PR を通ってしまった。
//   - このガード: **ローカルで書かれる全コミット**を、squash される前・type を問わず、
//     `git commit` が走る前に見る。見ている対象が CI と違うので置き換えではなく前倒しの層。
//
// なぜ git の commit-msg hook ではないのか (bdboard-ekj3 の設計判断):
//   このリポジトリは core.hooksPath を beads (.beads/hooks) に取られている。commit-msg を
//   足すには .beads/hooks へ書く (bd init が再生成する領域・PR で触れない) か core.hooksPath を
//   付け替える (共有 .git config なので、メインチェックアウトと全 worktree の beads hook 5 本が
//   同時に無効化される) しかない。どちらも代償が大きすぎるうえ、clone ごとの install 手順も要る。
//
// なぜ判定を正規表現ではなく本物のパーサでやるのか:
//   「行末に閉じない `(` がある行」を字句的に弾く案を実測した結果、main の 383 コミット中 198 件
//   (52%) が該当した。日本語の本文は括弧付きの補足を普通に折り返すので、字句規則では実用にならない。
//   実際にパーサが落ちるのは 40 件 (10.4%) で、うち 38 件が閉じない `(`。誤検知ゼロで狙った
//   ものだけ止めるには、release-please と同じパーサをそのまま通すしかない。
//   ただし 10.4% は allowlist 導入前の古い履歴を含む main 全体の数字で、日常の発火率ではない。
//   リリース対象範囲 v0.1.2..HEAD の 130 コミットで測ると解析不能は 2 件 (1.5%) しかなく、
//   うち 1 件は既に allowlist 済み。**普段はほぼ発火しない前提**のガードである。
//
// deny する範囲 (ここを広げないこと):
//   パーサの失敗のうち **「閉じ `)` を待っている状態で落ちたもの」だけ** を deny する。
//   エラー文の `valid tokens [)]` がその状態を表し、この状態になるのは `(` をスコープとして
//   食った後だけなので「閉じない `(` がある」と同義。main の解析不能 40 件のうち 38 件がこれで、
//   内訳は改行で落ちたもの 35 件・入れ子の `(` で落ちたもの 3 件。残り 2 件は件名が
//   conventional でない (`bd/bdboard 3tw.149 (#83)`) 別クラスで、allow + 1 行警告に倒す。
//   `wip` / `Revert "…"` / `Merge branch …` / `fixup!` / 空メッセージも同じく allow + 警告。
//   理由: このガードが存在するのは「著者に見えない不可逆な罠」を止めるためで、`wip` と打った
//   人はそれを自覚している。全 worktree の全 Bash 呼び出しに挟まるフックを conventional-commit の
//   スタイル強制装置へ広げると、override を常設させて本来の用途ごと無効化させることになる。
//
// 既知の限界 (指摘 m5): コマンド行に `git commit -m '<閉じない括弧>'` という文字列が現れれば、
//   それが実行ではなく言及 (`echo git commit -m '…'` や grep のパターン) でも deny する。
//   言及と実行を分けるにはトークナイザが意図的に持っていないシェル意味論が要るため、
//   override で通す運用に倒している。頻度が低いことは確認済み。
//
// 契約: stdin に Claude Code の hook 入力 JSON。deny は exit 2 + stderr、allow は exit 0。
// allow でも stderr に 1 行だけ出すことがある (括弧以外の解析失敗の警告 / override の使用痕跡)。
// 判定できないものはすべて allow に倒す (fail-open) — ガードが壊れて commit できなくなるより、
// 従来どおり CI の 2 層に戻る方が安全。fail-open の条件は下の各関数に個別に書いてある。
import { pathToFileURL } from 'node:url';

import { EXIT_ALLOW, main } from './commit-message-guard/cli.mjs';

export { OVERRIDE_ENV, MAX_MESSAGE_FILE_BYTES } from './commit-message-guard/constants.mjs';
export { extractHeredocs } from './commit-message-guard/heredoc.mjs';
export { tokenize, resolveDoubleQuoted } from './commit-message-guard/tokenize.mjs';
export { resolveTokenValue } from './commit-message-guard/resolve-value.mjs';
export { classifyFlag } from './commit-message-guard/flags.mjs';
export {
  extractCommitMessages,
  extractCommitMessage,
  findCommitStarts,
} from './commit-message-guard/invocation.mjs';
export { classifyParseFailure, evaluateCommand } from './commit-message-guard/evaluate.mjs';
export { formatDenial, formatNotice } from './commit-message-guard/format.mjs';

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // このフックは全 Bash 呼び出しに挟まる。何が起きても「通す」ところまでは必ず戻す。
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`commit-guard: skipped (${error?.message ?? error})\n`);
      process.exitCode = EXIT_ALLOW;
    });
}
