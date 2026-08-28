import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 200;

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
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const mainTs = path.join(repoRoot, 'src', 'main.ts');

  const debug = process.env.BDBOARD_E2E_DEBUG === '1';

  // cwd はリポジトリルートではなく使い捨てディレクトリにする (bdboard-gki)。
  // 配布形態 (npx bdboard) では任意の cwd から起動されるので、そちらに寄せた方が
  // 実態に近い。上の env はすべて絶対パスで渡しているので cwd には依存しない。
  // 注意: これは「相対 root だと壊れる」を捕まえるテストではない — 現行の
  // serve-static は root を検証しないので相対 root でもこの構成で通る。捕まえるのは
  // 「起動 cwd に依存して静的配信が壊れる」という性質そのもの。
  const serverCwd = path.join(tmpRoot, 'server-cwd');
  fs.mkdirSync(serverCwd, { recursive: true });

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
      BDBOARD_E2E_BD_LIST_FIXTURE: listFixture,
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
