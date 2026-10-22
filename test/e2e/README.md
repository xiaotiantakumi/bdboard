# test/e2e

Playwright の E2E。**spec は `smoke.spec.ts` の 1 本だけ** (bdboard-5wxf、2026-10-22 ユーザー決定:
「e2e は最小、単体テストが主な安全網」)。レイアウト・テーマ・モバイル等の確認は単体テスト
(vitest) で行い、ここへ spec を足さない。足す場合も 1 本のスモークの範囲 (起動して板が出る、詳細が開く) に留める。

`npm run test:e2e` (= `npm run build:web` してから
`playwright test --config test/e2e/playwright.config.ts`) で回す。**ルートに
`playwright.config.ts` は無い**ので `--config` は必須。この配下の相対 import は
`moduleResolution: node16` なので `.js` 拡張子を明示すること (省くと `error TS2835`)。
Desktop Chrome の 1 プロジェクトのみ。

`global-setup.ts` が偽 `bd` / `claude` (`fixtures/bin/`) と golden 一覧 (`test/fixtures/bd/bdboard.list.json`) を使う専用サーバを
空きポートで起動する (常時稼働の 8787 は使わない)。

## 落とし穴

- **単独実行だけ落ちる → まず `web/dist` の鮮度を疑う。** `npx playwright test` の直叩きは
  `build:web` をしないので、`global-setup.ts` は古い `web/dist` をそのまま配信する。
  調べる前に `npm run build:web` を走らせる (bdboard-hje9)。
- **`npm run test:e2e` は型検査をしない。** spec の型エラーは `npm run build` 側
  (`test/e2e/tsconfig.json`) でしか出ない。
