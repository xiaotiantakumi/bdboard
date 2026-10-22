import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildE2eServerEnv } from './e2e-server-env.js';
import { fetchHealthViaFetch, waitForHealth } from './wait-for-health.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

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
 * normalizeWorktreeRoot), and this repo's own root may have a real .beads/. A
 * fixture project nested under test/e2e would get silently rewritten to the
 * checkout root instead of staying the isolated fixture project. os.tmpdir()
 * is outside any git working tree, so that rewrite never triggers.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // playwright.config.ts が先に resolve して env へ書き戻しているはず。ここで自前採番すると
  // ワーカーの baseURL とサーバ bind が食い違い全 spec が接続拒否になるうえメッセージも無い。
  const port = process.env.BDBOARD_E2E_PORT;
  if (port === undefined || port === '') {
    throw new Error(
      'e2e global-setup: BDBOARD_E2E_PORT is unset — playwright.config.ts should resolve the port and write it to process.env before globalSetup runs; this path means that write-back is broken',
    );
  }
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
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const mainTs = path.join(repoRoot, 'src', 'main.ts');

  const debug = process.env.BDBOARD_E2E_DEBUG === '1';
  const instanceNonce = randomUUID();
  const healthUrl = `http://${host}:${port}/api/health`;
  const parsedPort = Number.parseInt(port, 10);

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
    // env の中身とその理由 (コメント) は e2e-server-env.ts。切り出したのは、サーバーが本物の gh を起動しないこと
    // (bdboard-em45) などを e2e を回さずに vitest で固定するため。
    env: buildE2eServerEnv({
      baseEnv: process.env,
      port,
      host,
      dbPath,
      scanRoots: [projectDir],
      scanRootsConfigPath: path.join(tmpRoot, 'scan-roots-config.json'),
      binDir,
      claudeStub,
      listFixture,
      webDist: webDistSnapshot,
      instanceNonce,
    }),
    stdio: debug ? 'inherit' : 'ignore',
  });

  let spawnError: Error | undefined;
  child.once('error', (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  try {
    await waitForHealth({
      url: healthUrl,
      port: parsedPort,
      expectedNonce: instanceNonce,
      isChildAlive: () => child.exitCode === null && child.signalCode === null,
      onChildNotAlive: () =>
        new Error(
          `bdboard e2e server exited before becoming healthy (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
        ),
      fetchHealth: fetchHealthViaFetch,
    });
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
