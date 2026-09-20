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
  'web/src/components/ChatPanel.tsx': 2309, // 現在 2301 (bdboard-sso1.2 PR-F でさらに分割)
  'web/src/components/TicketDetailPanel.tsx': 800, // 現在 757 (bdboard-sso1.5 PR-L: エージェント実行+ポーリングを useTicketAgentRun.ts + TicketAgentRunTriggerSection.tsx + TicketAgentRunSection.tsx へ、human decision 回答を useTicketDecisionAnswer.ts + TicketDecisionSection.tsx へ移動)
  'web/src/components/ticket-detail/useTicketAgentRun.ts': 260, // 現在 246 (bdboard-sso1.5 PR-L: エージェント実行+ポーリングの state/query/mutation/effect をカスタムフックへ抽出。move-only 抽出のため新規ファイルだが例外的にここへ追加。Opus レビュー対応でticketId変更リセットを内部effect化した分+4)
  'web/src/components/ticket-detail/TicketAgentRunSection.tsx': 250, // 現在 235 (bdboard-sso1.5 PR-L: エージェント実行の表示セクション(現在の状態/ログ/中止/実行履歴)を移動しただけの表示専用コンポーネント。move-only 抽出のため新規ファイルだが例外的にここへ追加)
  'web/src/components/SettingsPanel.tsx': 390, // 現在 372 (bdboard-sso1.10 PR-F: useScanRootsForm)
  'src/main.ts': 400, // 現在 400 (bdboard-sso1.14: 941 から分割)
  'web/src/components/HygienePanel.tsx': 260, // 現在 252 (bdboard-sso1.11 PR-C: useHygieneRepairActions フックへ移動)
  'web/src/components/hygiene/useHygieneRepairActions.ts': 315, // 現在 307 (bdboard-sso1.11 PR-C: repair/mutation ハンドラをカスタムフックへ抽出。move-only 抽出のため新規ファイルだが例外的にここへ追加)
  'web/src/App.tsx': 980, // 現在 976 (bdboard-sso1.13 PR-A でオーバーレイ/パネル制御を分割)
  'scripts/commit-message-guard.mjs': 670, // 現在 667
  'web/src/hooks/useNotificationEvents.ts': 620, // 現在 619
  'web/src/components/BulkActionBar.tsx': 570, // 現在 565
  'web/src/components/HelpPanel.tsx': 500, // 現在 496
  'web/src/components/LaneColumn.tsx': 490, // 現在 483
  'web/src/components/TunnelControl.tsx': 470, // 現在 468
  'web/src/components/BoardKeyboardNavProvider.tsx': 440, // 現在 437
  'web/src/components/PresetControl.tsx': 430, // 現在 428
  'web/src/components/SessionListPanel.tsx': 430, // 現在 427
  'scripts/check-drift.mjs': 410, // 現在 409
  'src/application/board/get-pr-badges.ts': 390, // 現在 388
  'src/application/runner/run-store.ts': 390, // 現在 381
  'scripts/check-commit-parse.mjs': 380, // 現在 380
  'web/src/components/nextUpRunLoop.ts': 380, // 現在 371
  'src/domain/board.ts': 370, // 現在 368
  'web/src/components/DependencyGraphView.tsx': 370, // 現在 367
  'web/src/components/BoardView.tsx': 370, // 現在 365
  'scripts/check-file-size.mjs': 370, // 現在 362
  'web/src/components/NextUpView.tsx': 370, // 現在 362
  'src/infrastructure/chat/cli-chat-agent.ts': 360, // 現在 351
  'src/infrastructure/chat/specs/claude-spec.ts': 340, // 現在 331
  'src/infrastructure/harness/fs-harness-injector.ts': 320, // 現在 312
  'src/infrastructure/process/cloudflared-tunnel.ts': 320, // 現在 311
  'src/infrastructure/process/ai-quota-source.ts': 310, // 現在 307
  'web/src/components/SearchPalette.tsx': 290, // 現在 282
  'src/application/lease/reclaim-scheduler.ts': 280, // 現在 280
  'src/infrastructure/process/ps-process-scanner.ts': 280, // 現在 279
  'web/src/api/chat.ts': 280, // 現在 279
  'src/domain/harness-kpi.ts': 270, // 現在 270
  'src/interface/http/harness-routes.ts': 270, // 現在 270
  'src/infrastructure/git/git-worktree-scanner.ts': 270, // 現在 269
  'src/interface/http/basic-auth.ts': 270, // 現在 262
  'src/interface/http/hygiene-routes.ts': 250, // 現在 247
  'src/application/tunnel/tunnel-service.ts': 250, // 現在 245
  'web/src/components/BoardFilterBar.tsx': 250, // 現在 241
  'src/domain/harness-hooks.ts': 240, // 現在 234
  'src/infrastructure/chat/repo-tool-catalog.ts': 230, // 現在 223
  'web/src/components/AiQuotaWidget.tsx': 220, // 現在 216
  'src/infrastructure/transcript/jsonl-transcript-scanner.ts': 220, // 現在 212
  'src/domain/in-flight-overlap.ts': 210, // 現在 204
  // テスト (1500 行超)
  'web/src/components/ChatPanel.test.tsx': 7630, // 現在 7627
  'src/interface/http/routes.test.ts': 6360, // 現在 6359
  'src/interface/http/chat-routes.test.ts': 3390, // 現在 3389
  'web/src/components/TicketDetailPanel.test.tsx': 2710, // 現在 2706
  'web/src/components/HygienePanel.test.tsx': 2100, // 現在 2098
  'src/interface/http/agent-run-routes.test.ts': 2010, // 現在 2007
  'src/domain/hygiene.test.ts': 1840, // 現在 1835
  'src/infrastructure/bd/bd-cli-human-decisions.test.ts': 1680, // 現在 1679
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
