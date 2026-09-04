import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 200;

/** index.html が参照する /assets/... がコピー先に揃っているか検証する */
function assertSpaBundleComplete(webDistDir: string): void {
  const indexPath = path.join(webDistDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `e2e setup: SPA bundle missing at ${indexPath}. ` +
        'Run "npm run build:web" (or "npm run test:e2e") before starting e2e.',
    );
  }

  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const assetRefs = [
    ...indexHtml.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g),
  ].map((match) => match[1]!);

  if (assetRefs.length === 0) {
    throw new Error(
      `e2e setup: index.html at ${indexPath} references no /assets/* — ` +
        'このチェックが機能していないか、バンドルが壊れています。',
    );
  }

  const missing = assetRefs.filter(
    (ref) => !fs.existsSync(path.join(webDistDir, ref.slice(1))),
  );
  if (missing.length > 0) {
    throw new Error(
      `e2e setup: SPA bundle incomplete — index.html references missing asset(s): ` +
        `${missing.join(', ')}. web/dist may have been empty or mid-rebuild when copied.`,
    );
  }
}

/** リポジトリの web/dist を tmpRoot 配下の不変スナップショットへコピーする */
function snapshotWebDist(repoRoot: string, tmpRoot: string): string {
  const sourceWebDist = path.join(repoRoot, 'web', 'dist');
  assertSpaBundleComplete(sourceWebDist);

  const snapshotDir = path.join(tmpRoot, 'web-dist');
  fs.cpSync(sourceWebDist, snapshotDir, { recursive: true });
  assertSpaBundleComplete(snapshotDir);

  return snapshotDir;
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `bdboard e2e server exited before becoming healthy (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
      );
    }

    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
      lastError = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastError = err;
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `bdboard e2e server did not become healthy within ${HEALTH_TIMEOUT_MS}ms: ${String(lastError)}`,
  );
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill();

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Boots a throwaway bdboard server for the E2E smoke suite: a real bd binary
 * is never installed (see test/e2e/fixtures/bin/bd), and the "beads project"
 * it scans is a fresh temp directory created here, never a path inside this
 * git repository.
 *
 * That "never inside this repo" part is load-bearing, not stylistic: project
 * discovery normalizes any candidate that sits inside a git working tree to
 * that tree's common .git root (src/application/discovery/discover-projects.ts,
 * normalizeWorktreeRoot), and this repo's own root has a real .beads/. A
 * fixture project nested under test/e2e would get silently rewritten to the
 * checkout root instead of staying the isolated fixture project. os.tmpdir()
 * is outside any git working tree, so that rewrite never triggers.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = process.env.BDBOARD_E2E_PORT ?? '8799';
  const host = '127.0.0.1';

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-e2e-'));
  const projectDir = path.join(tmpRoot, 'fixture-project');
  fs.mkdirSync(path.join(projectDir, '.beads'), { recursive: true });
  const dbPath = path.join(tmpRoot, 'cache.db');

  const binDir = path.join(here, 'fixtures', 'bin');
  const claudeStub = path.join(binDir, 'claude');
  try {
    fs.chmodSync(claudeStub, 0o755);
  } catch {
    // Best-effort: CI may already mark the stub executable.
  }
  const listFixture = path.join(
    repoRoot,
    'test',
    'fixtures',
    'bd',
    'bdboard.list.json',
  );
  const e2eBdFixturesDir = path.join(here, 'fixtures', 'bd');
  const gateListFixture = path.join(e2eBdFixturesDir, 'gate.list.json');
  const leaseFixture = path.join(e2eBdFixturesDir, 'lease.in-progress.json');
  const mergeSlotFixture = path.join(e2eBdFixturesDir, 'merge-slot.list.json');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const mainTs = path.join(repoRoot, 'src', 'main.ts');

  const debug = process.env.BDBOARD_E2E_DEBUG === '1';

  // cwd はリポジトリルートではなく使い捨てディレクトリにする (bdboard-gki)。
  // 配布形態 (npx bdboard) では任意の cwd から起動されるので、そちらに寄せた方が
  // 実態に近い。上の env はすべて絶対パスで渡しているので cwd には依存しない。
  // 注意: これは「相対 root だと壊れる」を捕まえるテストではない — 現行の
  // serve-static は root を検証しないので相対 root でもこの構成で通る。捕まえるのは
  // 「起動 cwd に依存して静的配信が壊れる」という性質そのもの。
  //
  // もう一点、cwd を移したことで tsx の tsconfig 探索もリポジトリから外れる。tsx は
  // tsconfig.json をエントリファイルではなく **cwd から** 探すので、ここでサーバーは
  // リポジトリの tsconfig.json 無しで走る。これは配布形態 (npx bdboard = 任意 cwd で
  // tsx 実行) と同じ条件なので意図どおりだが、将来 src/ に paths エイリアスを入れると
  // e2e だけが `Cannot find module` で落ちることになる。そのときは tsconfig を
  // 明示的に渡すこと。
  const serverCwd = path.join(tmpRoot, 'server-cwd');
  fs.mkdirSync(serverCwd, { recursive: true });

  // test:e2e と verify が同時に web/dist を書き換えると、並走ビルドが web/dist を
  // 空にしたあと /assets/*.js のリクエストにも SPA フォールバックが index.html を
  // 200 text/html で返し、module script の MIME 不一致で React がマウントしない。
  // 配信元を tmp へ固定する。
  let webDistSnapshot: string;
  try {
    webDistSnapshot = snapshotWebDist(repoRoot, tmpRoot);
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }

  const child = spawn(tsxBin, [mainTs], {
    cwd: serverCwd,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      BDBOARD_PORT: port,
      BDBOARD_HOST: host,
      BDBOARD_DB: dbPath,
      BDBOARD_SCAN_ROOTS: projectDir,
      // Points the scan-roots user-config store at a throwaway path inside this test's tmp
      // root so the e2e run never reads/writes the developer's real
      // ~/.config/bdboard/config.json (bdboard-3tw.102.2).
      BDBOARD_SCAN_ROOTS_CONFIG_PATH: path.join(tmpRoot, 'scan-roots-config.json'),
      // Auth is explicitly disabled (not "set fake creds and log in") so
      // this fixture never has to hold a username/password-shaped literal.
      BDBOARD_AUTH_DISABLED: '1',
      BDBOARD_AUTH_USER: '',
      BDBOARD_AUTH_PASSWORD: '',
      // Chat stays enabled for chat-mobile e2e; smoke scenarios never open the panel.
      BDBOARD_CLAUDE_PATH: claudeStub,
      BDBOARD_AI_QUOTA_DISABLED: '1',
      // src/main.ts:254 の envBoolDefaultTrue('BDBOARD_RECLAIM_ENABLED') を落として、
      // 自動 reclaim ループを e2e では止める。止めないと
      // web/src/components/HygienePanel.tsx:583-586 の分岐が「自動 reclaim は無効です」
      // ではなく reclaim 実行状況の行を描画し、そこに tmp のフルパス + bd スタブの
      // エラー文字列が折り返し指定無しで入る。375x812 で document.body.scrollWidth が
      // 375 → 437 に膨らみ、html{overflow-x:hidden} / body{overflow-x:clip} により
      // 62px が到達不能な切り取られ領域になる (実測: 修正前 437 / 修正後 375)。
      // 同時に起動のたびに出る
      // `Reclaim failed for project=...: bd stub: unsupported subcommand` のログノイズも消える。
      // 製品側の折り返し不足そのものは bdboard-z5tv に分離済み。
      BDBOARD_RECLAIM_ENABLED: '0',
      BDBOARD_E2E_BD_LIST_FIXTURE: listFixture,
      // 確認待ちレーンにも同じゴールデン一覧を流す。旧スタブは `list` を含む全形状に
      // これを返していたため、`bd list -l human` 由来の pendingDecisions が暗黙に
      // 埋まり、健全性パネルの stale_pending_decision 行 —
      // mobile-activity-hygiene-truncation.spec.ts の `.hygiene-issue-project` —
      // がそれに依存していた。形状別ディスパッチ化(bdboard-sp5q)で human 一覧が
      // 既定 `[]` になると、その行ごと消えてテストが落ちる。ここで明示的に配線し、
      // 「たまたま通っていた」状態を「意図して覆っている」状態に置き換える。
      BDBOARD_E2E_BD_HUMAN_LIST_FIXTURE: listFixture,
      // gate / lease / merge-slot は e2e 専用の最小 fixture (bdboard-vr71)。
      // global-setup で渡すので全 e2e spec に一律で効く — 特定の spec だけに
      // 効くものではない。
      //
      // lease fixture が健全性パネルに増やす行の kind バッジ
      // `stale lease（heartbeat 途絶）` は 182px・white-space: nowrap でパネル中
      // 最長。`.hygiene-issue-row` は grid-template-columns: auto auto 1fr
      // (web/src/index.css:1648) なので、この行だけ project 列 (1fr) が潰れる。
      // 結果として mobile-activity-hygiene-truncation.spec.ts:185-189 が全
      // `.hygiene-issue-project` に課している「省略されていない
      // (scrollWidth <= clientWidth)」の安全余白が 66px から 8px に縮んだ。
      // macOS Chromium 実測: 既存の `放置された確認待ち` 行は 145px 列に 78.75px で
      // 余白 66.25px、新しい stale lease 行は 87px 列に 78.75px で余白 8.25px。
      // truncation 系 spec が落ちたらまずここを疑うこと。
      //
      // (m4) lease.in-progress.json は bdboard-3tw.8 を
      // `bd list --status in_progress` の結果として返すが、ゴールデン一覧
      // test/fixtures/bd/bdboard.list.json ではこのチケットは "status": "open"。
      // 実物の bd では起こりえない組み合わせ。ゴールデン一覧に in_progress の
      // チケットが1件も無いため、lease fixture は open チケットの ID を借りている。
      // 盤面とは意図的に不整合であり、レーン件数を変えると他 spec に波及するため
      // 直していない (JSON にコメントが書けないのでここに書く)。
      //
      // (m6) lease.in-progress.json の heartbeat_at は、
      // src/domain/lease.ts:64-82 の detectStaleLeases が leaseExpiresAt しか見ないため
      // 完全に飾り。実物の出力形に寄せるためだけに置いてある。
      BDBOARD_E2E_BD_GATE_LIST_FIXTURE: gateListFixture,
      BDBOARD_E2E_BD_LEASE_FIXTURE: leaseFixture,
      BDBOARD_E2E_BD_MERGE_SLOT_FIXTURE: mergeSlotFixture,
      BDBOARD_WEB_DIST: webDistSnapshot,
    },
    stdio: debug ? 'inherit' : 'ignore',
  });

  let spawnError: Error | undefined;
  child.once('error', (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  try {
    await waitForHealth(`http://${host}:${port}/api/health`, child);
  } catch (err) {
    await killAndWait(child);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw spawnError ?? err;
  }

  return async () => {
    await killAndWait(child);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };
}
