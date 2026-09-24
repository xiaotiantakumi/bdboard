// @ts-check
// bdboard-sso1.8: ESLint + typescript-eslint の単一設定。PicRill-9c4.2 の構成
// (MAX_LINES_ALLOWLIST によるラチェット方式、tsconfig に入らない js/mjs は
// disableTypeChecked) に揃えている。
//
// lint 対象は src/ (サーバー) と web/src/ (React+Vite) と scripts/ (補助スクリプト)
// の3ディレクトリのみ。行数ガード (scripts/check-file-size.mjs) と二重管理しない
// ため、この3ディレクトリ配下の .ts/.tsx/.mjs の行数上限は max-lines ルールに一本化
// する (check-file-size 側は index.css など ESLint が見ない拡張子専用に絞ってある)。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// 既存の超過ファイルだけを記録する。新しいファイルはここに足さない。
// 分割して既定上限以下になったら行を消し、上限の数字は下げる方向にしか変えない
// (詳細: docs/VERIFY.md「ファイルサイズガード」に準ずる運用を max-lines に適用)。
const MAX_LINES_ALLOWLIST = {
  // 非テスト (200 行超, 分割して収まったら消す)
  'web/src/components/ChatPanel.tsx': 697, // 現在 687 (ESLint実測。bdboard-sso1.83 第15a段: 回収の hydrate・23u prune・CLI セッション再開を chat/useChatSessionLifecycle.ts へ抽出)
  // 'web/src/components/TicketDetailPanel.tsx' はこの一覧から除去 (bdboard-sso1.5:
  // 残っていたフック呼び出し群を useTicketDetailController.ts/useTicketDetailQueries.ts へ、
  // 本体JSXを TicketDetailBody.tsx/TicketDetailSecondaryBody.tsx へ切り出し、
  // 680 -> 141 行(ESLint実測)まで縮小。既定上限200行に対して59行の余裕がある)。
  // テスト (1500 行超): 該当なし (ChatPanel.test.tsx は #669, TicketDetailPanel.test.tsx は
  // bdboard-sso1.88 でそれぞれ分割し、両方ともこの一覧から除去した。web/src/App.tsx は
  // bdboard-62p4 第6段で 6行(ESLint実測)まで縮小しこの一覧から除去した)
};

const NON_TEST_MAX_LINES = 200;
const TEST_MAX_LINES = 1500;

const maxLinesOptions = (max) => ['error', { max, skipBlankLines: true, skipComments: true }];

const allowlistedMaxLines = Object.entries(MAX_LINES_ALLOWLIST).map(([file, max]) => ({
  files: [file],
  rules: { 'max-lines': maxLinesOptions(max) },
}));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'web/dist/**',
      '**/node_modules/**',
      'harness/**',
      '.claude/**',
      '.agents/**',
      '.codex/**',
      'data/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // tsconfig の include に入らない補助スクリプト (mjs) は型情報なしで lint する。
    files: ['scripts/**/*.mjs'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      tseslint.configs.disableTypeChecked,
    ],
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.test.mjs'],
    // node:test / vitest の it()/describe() は Promise を返すため、テストでは誤検知を避ける。
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // 型情報を要するルール (require-await 等) は scripts/**/*.mjs (disableTypeChecked =
    // parserOptions.project 無し) では rule 作成自体が例外を投げるため、型ありファイルだけに絞る。
    files: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
    // 既存違反の台帳 (eslint . -f json 実測、max-lines を除く)。max-lines 以外の既存違反は
    // --fix の一括適用をこの PR ではせず、件数を記録した上で warn に落とす。新規違反を出さない
    // ルールだけ error のまま残す。
    // @typescript-eslint/require-await: 1065
    // @typescript-eslint/no-unsafe-assignment: 274
    // @typescript-eslint/no-unsafe-member-access: 252
    // @typescript-eslint/unbound-method: 246
    // @typescript-eslint/no-unnecessary-type-assertion: 183
    // @typescript-eslint/no-misused-promises: 109
    // @typescript-eslint/no-unsafe-call: 52
    // @typescript-eslint/no-unsafe-argument: 15
    // @typescript-eslint/no-unsafe-return: 8
    // @typescript-eslint/only-throw-error: 1
    // @typescript-eslint/await-thenable: 1
    // @typescript-eslint/no-redundant-type-constituents: 1
    rules: {
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
    },
  },
  {
    // 型情報を要しない既存違反の台帳。scripts/**/*.mjs も含めた3ディレクトリ共通。
    files: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
    // @typescript-eslint/no-unused-vars: 38
    // prefer-const: 12
    // @typescript-eslint/no-explicit-any: 7
    // no-useless-escape: 7
    // preserve-caught-error: 3
    // no-control-regex: 3
    // no-useless-assignment: 3
    // no-fallthrough: 2
    // no-case-declarations: 2
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
      'no-control-regex': 'warn',
      'no-useless-assignment': 'warn',
      'no-fallthrough': 'warn',
      'no-case-declarations': 'warn',
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    // react-hooks/* の既存違反の台帳 (plugin 登録がこの files パターンの config object に
    // しかないため、上のブロックとは別に分けている)。
    // react-hooks/set-state-in-effect: 32
    // react-hooks/refs: 31
    // react-hooks/preserve-manual-memoization: 7
    // react-hooks/immutability: 3
    // react-hooks/purity: 2
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
    rules: { 'max-lines': maxLinesOptions(NON_TEST_MAX_LINES) },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.test.mjs'],
    rules: { 'max-lines': maxLinesOptions(TEST_MAX_LINES) },
  },
  ...allowlistedMaxLines,
);
