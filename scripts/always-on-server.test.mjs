// bdboard-hpu8: scripts/always-on-server.sh (常時稼働サーバーの唯一の再起動入口) のテスト。
//
// 本物の 8787 には触れない。git 化した一時ディレクトリに「npm run start で /api/health に
// 200 を返す偽サーバー」を置き、空きポートで start → restart (--expect-pid の CAS) →
// 各種の拒否 (呼び出し元未宣言・PID 不一致・二重起動) を実際のプロセスで確かめる。
// Windows は skip (bash / lsof / nohup 前提)。
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
