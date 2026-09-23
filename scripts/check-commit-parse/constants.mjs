// scripts/check-commit-parse.mjs から切り出した定数群 (allowlist・件名判定・exit code・
// パーサ位置抽出用の正規表現)。bdboard-sso1.63: move-only 分割。
export const MANIFEST_FILE = '.release-please-manifest.json';

/**
 * 解析不能と分かっているコミットの除外リスト。**エントリは例外**で、増やす前に下の条件を読むこと。
 *
 * 検査範囲は `v<last>..HEAD` なので、解析不能コミットは次のリリースタグを切った時点で
 * 自動的に範囲外になる。つまりこのリストが要るのは「解析不能コミットが main に載って
 * しまい、次のタグを切るまでの間、毎回の main push が赤くなる」という一時的な状況だけ。
 *
 * **エントリの形** (bdboard-721p): 文字列ではなくオブジェクトで、`recovery` が必須。
 * `recovery` を持たないエントリは除外として採用されない (fail-closed)。これは
 * 「CHANGELOG から黙って消える」事象を allowlist 自身が引き起こさないための歯止めで、
 * 除外した分の手当ては毎回の実行で `formatFindings` が全文を再掲する。
 *
 * 旧ルールは「足す前に CHANGELOG へ該当行を手で復元しておくこと」だったが、
 * release-please は always-update: true でリリースPRブランチを main push のたびに
 * 再生成する (bdboard-2tch) ため、先に復元しても次の push で消える = 原理的に満たせない。
 * 実行可能な条件に置き換えたのが上の `recovery` 必須化。
 *
 * 発端の 15651d3 (bdboard-r5we) は v0.1.2 のタグ (f2662b6) が切られて範囲外になったため
 * 削除した。CHANGELOG の行はリリースブランチへ手で足して回復済み (c8a94d4)。
 */
export const KNOWN_UNPARSABLE = [
  {
    // bdboard-ym9r / bdboard-721p。main 上の既存コミットなので履歴書き換え以外に直す手が無く、
    // v0.2.0 のタグを切るまで v0.1.2..HEAD の範囲に残り続けて main push を毎回赤くしていた。
    // 新規発生の防止は PR 側チェック (bdboard-qhsb, ci.yml の pull_request 分岐) が担うので、
    // main push 側でこの 1 件を落とし続ける価値は「タグ前の手当てを忘れないこと」だけ。
    // それは exit 1 ではなく下の recovery の恒久表示で担保する。
    // **削除できるのは v0.2.0 のタグが切られた後** (範囲外になり、下の unused 通知が出る)。
    sha: '5d3be460e19479cfe2fb8e06249bb096a6fcbf7f',
    subject: 'feat(bdboard-h4xs.1): スマホ幅のKanbanにレーン切り替えストリップを追加する (#260)',
    ticket: 'bdboard-ym9r',
    recovery: [
      'リリースPR #258 をマージする直前に、そのブランチの CHANGELOG.md 0.2.0 の Features へ次の 1 行を手で追記する:',
      '  * **bdboard-h4xs.1:** スマホ幅のKanbanにレーン切り替えストリップを追加する ([#260](https://github.com/xiaotiantakumi/bdboard/issues/260)) ([5d3be46](https://github.com/xiaotiantakumi/bdboard/commit/5d3be460e19479cfe2fb8e06249bb096a6fcbf7f))',
      'release-please は always-update: true なので、追記後に main へ push が入ると再生成で消える。',
      '「他の全PRをマージ済み → 追記 → 直後に #258 をマージ」を連続で行うこと。タグを切った後は永久に回復できない。',
    ].join('\n'),
  },
];

export const CHANGELOG_TYPES = new Set(['feat', 'fix', 'perf', 'revert', 'deps']);
export const CONVENTIONAL_SUBJECT =
  /^(\w+)(\(([^)]*)\))?(!)?: /;

export const EXIT_OK = 0;
export const EXIT_FOUND = 1;
export const EXIT_UNAVAILABLE = 2;

export const LOCATION_RE = /\bat (\d+):(\d+)/;

export const EXPLICIT_RANGE_FLAGS = new Set(['--range', '--from', '--to']);

export const MIN_ALLOWLIST_PREFIX_LEN = 7;
