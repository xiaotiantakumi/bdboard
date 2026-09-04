# 検証 (Build & Test) の詳細

AGENTS.md「Build & Test」から分離した詳細。**`npm run verify` を回す前に読む必要は無い** —
必要になるのは次のときだけ:

- 個別の tsc プロジェクト構成を触る / 新しい設定ファイルを足す（下の「tsc プロジェクトの表」）
- `npm run verify` が待たされている・スロット関連のメッセージが出た（下の「Verify slots」）
- ローカルの起動 (`npm run start` / `dev` / `dev:web`) の違いを確認したい

AGENTS.md 側に残っている 1 行要約と食い違ったら、**この文書が詳細の正**。ただし slot の実装挙動は
`scripts/verify.mjs` / `scripts/verify-slot.mjs` が正で、この文書はその要約。

## 全体

コミット前 (server / web どちらの変更でも) に、フル検証チェーンをクリーンに通すこと:

```bash
npm run verify   # build (server tsc) + build:web (web tsc + vite build) + test:server + test:web + check:boundaries
```

## tsc プロジェクトの表

`npm run build` は**サーバー側**を型チェックする。3 つの別々の tsc プロジェクトを直列に走らせる。
前提 (`rootDir`, `lib`, `types`) が両立しないため 1 つの config にまとめられない:

| project | covers | why separate |
|---|---|---|
| `tsconfig.json` | `src/**/*` | server. `rootDir: src` |
| `tsconfig.node.json` | `vitest.config.ts` | `lib: ["ES2023"]` + `types: ["node"]`, **no DOM** |
| `test/e2e/tsconfig.json` | `test/e2e/**/*.ts` (recursive — `fixtures/` included) | needs `DOM` for `page.evaluate`, so it can't share the row above |

`web/` has its own pair of `tsc --noEmit` steps inside `npm run build:web` (`tsconfig.json` for
`web/src` + `web/vitest.setup.ts`, `tsconfig.node.json` for `web/vite.config.ts` +
`web/vitest.config.ts`), ahead of the Vite
build — a real type error there is invisible to `npm run build` and to `npm run test:web` (vitest
doesn't full-type-check). `npm run verify` runs all of it, plus the web Vite build itself, so nothing
can silently drift broken (see bdboard-419 for the incident that prompted this, bdboard-ruf for the
`web/` config files, and bdboard-u97 for the root ones).

The rule behind the table: **a config file that is never imported by anything still has to belong to
some tsc project, or it is unchecked.** `include` is what puts a file in a project; being reachable
by import is not enough, and neither is sitting next to files that are checked.

## 個別コマンド

サブセットだけ回したいとき:

```bash
npm run build            # tsc --noEmit x3 (src/, vitest.config.ts, test/e2e/)
npm run build:web        # web tsc --noEmit x2 + vite build
npm run test:server      # vitest run (src/)
npm run test:web         # vitest run (web/src/)
npm run check:boundaries # dependency-cruiser (architecture layering)
```

## Verify slots (max 2 concurrent `npm run verify` per machine)

`npm run verify` throttles itself: before running anything, `scripts/verify.mjs`
takes a slot in a machine-local FIFO ticket queue (holder files under
`$TMPDIR/bdboard-verify-slots/`, logic in `scripts/verify-slot.mjs`), and at
most **2** verifies run at once per machine. This is the fix for the
2026-08-18 incident where 6 concurrent verifies self-amplified into load
average 190–258 for hours (bdboard-d48) — the per-run vitest worker caps
(bdboard-255) cannot prevent that alone, because more *submissions* still
pile up. Unlike `bd merge-slot`, this is not a cooperative convention you
must remember to follow: the lock lives inside the only sanctioned entry
point, so every `npm run verify` is throttled automatically, and there is no
bead behind it (nothing new to exclude from `bd ready`).

What this means operationally:

- **Always run the full chain via `npm run verify`.** Never run
  `npm run verify:steps` directly — it is the wrapper's internal entry point
  and bypasses both the process-group kill (bdboard-kia) and the slot.
  Running individual steps (`npm run build`, `npm run test:server`, …) while
  iterating is still fine; the slot only guards the full chain.
- **Queue waits are normal, not hangs.** While waiting, verify prints
  `verify: waiting for a verify slot (queue position N/M, holders: pid …)`
  every 10s on stderr. Leave it queued — the queue is FIFO, so the wait is
  bounded, and killing + re-running re-enters the queue at the back. Give
  the command a generous timeout instead of assuming it wedged.
- **Stale handling is automatic.** A holder whose pid is dead is reclaimed
  immediately (covers SIGKILLed verifies); a live holder in the queue for
  >30 min stops counting toward the limit (logged, file left alone). If a
  wait exceeds 15 min, verify exits non-zero naming the holder pids —
  investigate those pids (hung verify?) rather than disabling the slot.
- **Env knobs are for tests and emergencies only**: `BDBOARD_VERIFY_SLOTS`
  (default 2; `0` disables gating), `BDBOARD_VERIFY_SLOT_DIR`,
  `BDBOARD_VERIFY_SLOT_WAIT_MS`. Do not raise or disable them just to run
  more verifies in parallel — that recreates the incident. CI needs no
  special casing (one verify per runner; the slot is acquired instantly).

## ローカル起動コマンドの違い

`npm run start` serves the backend + built `web/dist` together on `BDBOARD_PORT` (default `8787` —
`.claude/launch.json`'s preview port must match this, not 3000). `npm run dev` / `npm run dev:web` are
for local iteration (server watch mode / Vite dev server, respectively).

worktree での起動可否・常時稼働サーバーの扱いは skill `bdboard-server-ops`
(`.claude/skills/bdboard-server-ops/SKILL.md`) を参照。

## コミットのパースチェック (`npm run check:commits`)

on each main push, CI scans
`v<last-release>..HEAD` with the same `@conventional-commits/parser` that
release-please uses. If a commit body opens `(` on one line and closes `)` on
the next, the parser fails and release-please silently drops that commit from
CHANGELOG — permanently once the release tag is cut. Fix or hand-restore before
tagging.

`scripts/check-commit-parse.mjs` exposes a `KNOWN_UNPARSABLE` allowlist for
this, and it is **empty by design**. The check scans `v<last-release>..HEAD`,
so an unparsable commit leaves the range by itself once the next tag is cut —
the list is only for the temporary window where such a commit sits on `main`
and turns every push red. Before adding an entry you must hand-restore the
CHANGELOG line first; excluding without restoring causes the exact silent drop
this guard exists to catch. (The original `15651d3` entry was removed once the
`v0.1.2` tag put it out of range — bdboard-r5we, bdboard-tbgj.)

Not part of `npm run verify` (needs git tags).
