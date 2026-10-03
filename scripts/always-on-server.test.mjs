// bdboard-hpu8: scripts/always-on-server.sh (常時稼働サーバーの唯一の再起動入口) のテスト。
//
// 本物の 8787 には触れない。git 化した一時ディレクトリに「npm run start で /api/health に
// 200 を返す偽サーバー」を置き、空きポートで start → restart (--expect-pid の CAS) →
// 各種の拒否 (呼び出し元未宣言・PID 不一致・二重起動) を実際のプロセスで確かめる。
// Windows は skip (bash / lsof / nohup 前提)。
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./always-on-server.sh', import.meta.url));

const FAKE_SERVER = `
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.env.BDBOARD_PORT || 8787);
const root = fs.realpathSync(process.cwd());
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => {
  console.log('Serving static web UI from ' + root + '/web/dist');
  console.log('fake bdboard listening on http://127.0.0.1:' + port);
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
setTimeout(() => process.exit(0), 120000).unref();
`;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function hasPortTool() {
  const result = spawnSync('bash', ['-c', 'command -v lsof >/dev/null 2>&1 || command -v ss >/dev/null 2>&1']);
  return result.status === 0;
}

describe.skipIf(process.platform === 'win32' || !hasPortTool())('always-on-server.sh', () => {
  let tmpRoot;
  let repo;
  let port;
  let env;

  function run(args, extraEnv = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function chair(args, extraEnv = {}) {
    return run(args, { BDBOARD_SERVER_CALLER: 'chair', ...extraEnv });
  }

  function listenerPid() {
    const status = run(['status', '--port', String(port)]);
    const match = /listener PID\s*:\s*([0-9]+)/.exec(status.stdout);
    return match === null ? null : Number(match[1]);
  }

  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-always-on-'));
    repo = path.join(tmpRoot, 'repo');
    mkdirSync(path.join(repo, 'web', 'dist'), { recursive: true });
    writeFileSync(path.join(repo, 'web', 'dist', 'index.html'), '<html></html>');
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'fake-bdboard', private: true, scripts: { start: 'node server.js' } }),
    );
    writeFileSync(path.join(repo, 'server.js'), FAKE_SERVER);
    port = await findFreePort();
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(tmpRoot, 'home'),
      BDBOARD_SERVER_LOG: path.join(tmpRoot, 'server.log'),
      BDBOARD_SERVER_AUDIT_LOG: path.join(tmpRoot, 'restarts.log'),
      BDBOARD_SERVER_LOCK_DIR: path.join(tmpRoot, 'restart.lock.d'),
    };
    mkdirSync(env.HOME, { recursive: true });
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=bdboard-test',
      '-c',
      'user.email=bdboard-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'fake server',
    );
  });

  afterAll(() => {
    const pid = listenerPid();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('prints usage for --help and rejects unknown actions / missing arguments', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('always-on-server.sh');
    expect(help.stdout).toContain('--expect-pid');

    expect(run([]).status).toBe(1);
    const unknown = run(['bogus']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown action: bogus');
    expect(chair(['restart', '--port', String(port)]).status).toBe(1);
  });

  it('refuses side-effecting actions unless BDBOARD_SERVER_CALLER=chair is declared', () => {
    for (const action of ['start', 'restart', 'deploy']) {
      const result = run([action, '--port', String(port), '--expect-pid', '1']);
      expect(result.status).toBe(4);
      expect(result.stderr).toContain('BDBOARD_SERVER_CALLER=chair');
    }
    // status は誰でも読める。
    expect(run(['status', '--port', String(port)]).status).toBe(0);
  });

  it('refuses restart when --expect-pid does not match what is listening', () => {
    const result = chair(['restart', '--port', String(port), '--expect-pid', '1', '--tunnel-ack']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('PID MISMATCH');
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('result=pid-mismatch');
  });

  it('--dry-run only prints the plan', () => {
    const result = chair(['start', '--port', String(port), '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run] action=start');
    expect(result.stdout).toContain('nohup npm run start');
    expect(result.stdout).toContain('[dry-run] node 版チェック');
    expect(listenerPid()).toBeNull();
  });

  it('start → restart (CAS) → refuses a second start; every step leaves an audit line', () => {
    const started = chair(['start', '--port', String(port), '--tunnel-ack']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    expect(started.stdout).toContain('== OK: PID none ->');
    const firstPid = listenerPid();
    expect(firstPid).not.toBeNull();

    const again = chair(['start', '--port', String(port), '--tunnel-ack']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('restart を使ってください');

    const stale = chair(['restart', '--port', String(port), '--expect-pid', '1', '--tunnel-ack']);
    expect(stale.status).toBe(3);
    expect(listenerPid()).toBe(firstPid);

    const restarted = chair([
      'restart',
      '--port',
      String(port),
      '--expect-pid',
      String(firstPid),
      '--tunnel-ack',
    ]);
    expect(restarted.stderr).toBe('');
    expect(restarted.status).toBe(0);
    expect(restarted.stdout).toContain(`== OK: PID ${firstPid} ->`);
    const secondPid = listenerPid();
    expect(secondPid).not.toBeNull();
    expect(secondPid).not.toBe(firstPid);

    const serverLog = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    expect(serverLog).toContain('Serving static web UI from');
    const audit = readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8');
    expect(audit).toContain(`\tstart\tcaller=chair\told=\tnew=${firstPid}\t`);
    expect(audit).toContain(`\trestart\tcaller=chair\told=${firstPid}\tnew=${secondPid}\t`);
    expect(audit.split('\n').filter((line) => line.endsWith('result=ok')).length).toBe(2);
  }, 90_000);
});

// bdboard-qoxg: 停止前の node 版ゲート。実際の事故は nvm 既定の node v14.15.0 で deploy が走り、
// build:web が `||=` の SyntaxError で落ちたのに exit 0 を返し、旧 listener を止めた後で起動に失敗したこと。
// ここでは「PATH 上の node では満たせない要件」を engines.node >=999.0.0 で模し (実 node は相対的に
// 古い node になる)、start / restart --build / deploy のどれも旧 listener を止める前に exit 2 で
// 止まること、満たす要件では従来どおり進むことを、origin (bare) から clone した使い捨てリポジトリと
// 偽サーバーで確かめる。本物の古い node でチェッカー自体が走ることは
// scripts/node-version-guard.old-node.test.mjs (BDBOARD_OLD_NODE) が見る。
describe.skipIf(process.platform === 'win32' || !hasPortTool())('always-on-server.sh node version gate', () => {
  const TOO_OLD = '>=999.0.0';
  let tmpRoot;
  let repo;
  let other;
  let port;
  let env;

  function run(args, extraEnv = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function chair(args) {
    return run(args, { BDBOARD_SERVER_CALLER: 'chair' });
  }

  function listenerPid() {
    const match = /listener PID\s*:\s*([0-9]+)/.exec(run(['status', '--port', String(port)]).stdout);
    return match === null ? null : Number(match[1]);
  }

  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  function commitAll(cwd, message) {
    git(cwd, 'add', '.');
    git(
      cwd,
      '-c',
      'user.name=bdboard-test',
      '-c',
      'user.email=bdboard-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    );
  }

  function writePackage(dir, enginesNode) {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fake-bdboard',
        private: true,
        engines: { node: enginesNode },
        scripts: { start: 'node server.js' },
      }),
    );
  }

  async function waitForNoListener() {
    for (let attempt = 0; attempt < 50 && listenerPid() !== null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-always-on-node-gate-'));
    repo = path.join(tmpRoot, 'repo');
    other = path.join(tmpRoot, 'other');
    const origin = path.join(tmpRoot, 'origin.git');
    port = await findFreePort();
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(tmpRoot, 'home'),
      BDBOARD_SERVER_LOG: path.join(tmpRoot, 'server.log'),
      BDBOARD_SERVER_AUDIT_LOG: path.join(tmpRoot, 'restarts.log'),
      BDBOARD_SERVER_LOCK_DIR: path.join(tmpRoot, 'restart.lock.d'),
    };
    mkdirSync(env.HOME, { recursive: true });
    mkdirSync(path.join(repo, 'web', 'dist'), { recursive: true });
    writeFileSync(path.join(repo, 'web', 'dist', 'index.html'), '<html></html>');
    writeFileSync(path.join(repo, 'server.js'), FAKE_SERVER);
    writeFileSync(path.join(repo, '.nvmrc'), '22\n');
    writePackage(repo, '>=1.0.0');
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    commitAll(repo, 'fake server');
    git(tmpRoot, 'init', '-q', '--bare', origin);
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(tmpRoot, 'clone', '-q', origin, other);
  });

  afterAll(() => {
    const pid = listenerPid();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('proceeds as before when the running node satisfies engines.node', () => {
    const started = chair(['start', '--port', String(port), '--tunnel-ack']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    expect(started.stdout).toContain('== OK: PID none ->');
    expect(listenerPid()).not.toBeNull();
  }, 60_000);

  it('restart --build stops before touching the listener when the node is too old', () => {
    const pid = listenerPid();
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    writePackage(repo, TOO_OLD);

    const result = chair(['restart', '--port', String(port), '--expect-pid', String(pid), '--build', '--tunnel-ack']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(TOO_OLD);
    expect(result.stderr).toContain(`v${process.versions.node}`);
    expect(result.stderr).toContain('サーバーは触っていません');
    // build:web (この偽リポジトリには無いスクリプト) まで進んだなら別のエラーになる。ゲートが先に止めた証拠。
    expect(result.stderr).not.toContain('build:web');
    expect(result.stdout).not.toContain('== stopping');
    expect(listenerPid()).toBe(pid);
    expect(run(['status', '--port', String(port)]).stdout).toContain('HTTP 200');
    expect(readFileSync(env.BDBOARD_SERVER_LOG, 'utf8')).toBe(logBefore);
    const audit = readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8');
    expect(audit).toContain('\trestart\tcaller=chair\t');
    expect(audit).toContain('result=node-version');
  }, 60_000);

  it('deploy judges the engines.node it just pulled, and leaves the listener running', () => {
    const pid = listenerPid();
    git(repo, 'checkout', '--', 'package.json'); // 作業ツリーは >=1.0.0 (満たす) に戻す
    writePackage(other, TOO_OLD);
    commitAll(other, 'raise engines.node');
    git(other, 'push', '-q', 'origin', 'main');
    const originHead = git(other, 'rev-parse', 'HEAD');

    const result = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(TOO_OLD);
    expect(result.stderr).toContain('pull は完了しています');
    expect(result.stderr).toContain('サーバーは触っていません');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originHead);
    expect(listenerPid()).toBe(pid);
    expect(run(['status', '--port', String(port)]).stdout).toContain('HTTP 200');
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('\tdeploy\tcaller=chair\t');
  }, 60_000);

  it('start refuses without starting a listener when the node is too old', async () => {
    process.kill(listenerPid(), 'SIGTERM');
    await waitForNoListener();
    expect(listenerPid()).toBeNull();

    const result = chair(['start', '--port', String(port), '--tunnel-ack']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(TOO_OLD);
    expect(result.stderr).toContain('サーバーは触っていません');
    expect(result.stdout).not.toContain('== starting');
    expect(listenerPid()).toBeNull();
  }, 60_000);

  it('fails closed when the checker itself cannot run on a very old node', () => {
    // node-version-check.mjs が SyntaxError 等で落ちる (exit 1) 古すぎる node を模す。
    const oldBin = path.join(tmpRoot, 'old-bin');
    mkdirSync(oldBin, { recursive: true });
    writeFileSync(path.join(oldBin, 'node'), '#!/bin/sh\necho "SyntaxError: Unexpected token" >&2\nexit 1\n');
    chmodSync(path.join(oldBin, 'node'), 0o755);

    const result = run(['start', '--port', String(port), '--tunnel-ack'], {
      BDBOARD_SERVER_CALLER: 'chair',
      PATH: `${oldBin}:${env.PATH}`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('node の版チェックを実行できませんでした');
    expect(result.stderr).toContain('サーバーは触っていません');
    expect(result.stdout).not.toContain('== starting');
    expect(listenerPid()).toBeNull();
  }, 60_000);
});
