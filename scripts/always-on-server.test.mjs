// bdboard-hpu8: scripts/always-on-server.sh (常時稼働サーバーの唯一の再起動入口) のテスト。
//
// 本物の 8787 には触れない。git 化した一時ディレクトリに「npm run start で /api/health に
// 200 を返す偽サーバー」を置き、空きポートで start → restart (--expect-pid の CAS) →
// 各種の拒否 (呼び出し元未宣言・PID 不一致・二重起動) を実際のプロセスで確かめる。
// Windows は skip (bash / lsof / nohup 前提)。
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

  function chair(args, extraEnv = {}) {
    return run(args, { BDBOARD_SERVER_CALLER: 'chair', ...extraEnv });
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

  it('deploy stops before pulling when the shell node is already too old, so the same command can be retried', () => {
    // 一番よくある原因 (シェル既定の node が古いだけ、pull は engines.node を変えない)。pull の前に
    // 止まるので main checkout は動かず、node を直して同じ deploy を打ち直せば入れ直しまで進む。
    // pull の後に止めていた版では、2 回目は OLD_HEAD == NEW_HEAD で「変更なし」になり何もしなかった
    // (PR #825 のレビュー)。作業ツリーの package.json は前のテストで TOO_OLD のまま。
    const pid = listenerPid();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(path.join(other, 'src'), { recursive: true });
    writeFileSync(path.join(other, 'src', 'marker.txt'), 'server-side change\n');
    commitAll(other, 'server-side change that does not touch package.json');
    git(other, 'push', '-q', 'origin', 'main');
    const originHead = git(other, 'rev-parse', 'HEAD');

    const refused = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack']);

    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain(TOO_OLD);
    expect(refused.stderr).toContain('同じコマンドを再実行');
    expect(refused.stderr).not.toContain('pull は完了しています');
    expect(refused.stdout).not.toContain('pull --ff-only');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(listenerPid()).toBe(pid);

    git(repo, 'checkout', '--', 'package.json'); // node を直した (要件を満たす) ことに相当
    const retried = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack']);

    expect(retried.status, retried.stderr).toBe(0); // stderr には git pull の fetch 表示が出る
    expect(retried.stdout).toContain('== OK: PID');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originHead);
    expect(listenerPid()).not.toBeNull();
    expect(listenerPid()).not.toBe(pid);
  }, 90_000);

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
    // 同じ deploy の再実行は、最後にデプロイに成功した版からの差分で入れ直すので、そのまま案内する
    // (bdboard-oga4。以前は「変更なし」で何もしないため restart --build を案内していた)。
    expect(result.stderr).toContain('node を直して同じコマンドを再実行');
    expect(result.stderr).not.toContain('deploy を同じコマンドで再実行しても');
    expect(result.stderr).not.toContain('--build');
    expect(result.stderr).toContain('サーバーは触っていません');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originHead);
    expect(listenerPid()).toBe(pid);
    expect(run(['status', '--port', String(port)]).stdout).toContain('HTTP 200');
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('\tdeploy\tcaller=chair\t');

    // node を直した (満たす要件にした) ことに相当する。コミットは足さず、同じ deploy を打ち直すと
    // pull 済みの package.json の変更も含めて install → build → 再起動まで進む。npm install は使い捨て
    // リポジトリ (依存なし) 向けに、ネットワークを使わない設定で走らせる。package.json が変わったので
    // deploy は build:web も走らせる (偽の build は index.html を作り直すだけ)。
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: 'fake-bdboard',
        private: true,
        engines: { node: '>=1.0.0' },
        scripts: {
          start: 'node server.js',
          'build:web': `node -e "require('fs').writeFileSync('web/dist/index.html', '<html>rebuilt</html>')"`,
        },
      }),
    );
    const retried = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack'], {
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    });
    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.stdout).not.toContain('server-side unchanged');
    expect(retried.stdout).toContain('== npm install');
    expect(retried.stdout).toContain(`== OK: PID ${pid} ->`);
    expect(listenerPid()).not.toBe(pid);
    git(repo, 'checkout', '--', 'package.json'); // 次のテストは、コミット済みの TOO_OLD を前提にする
  }, 90_000);

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
    writeFileSync(
      path.join(oldBin, 'node'),
      '#!/bin/sh\nif [ "$1" = --version ]; then echo v14.15.0; exit 0; fi\necho "SyntaxError: Unexpected token \'||=\'" >&2\nexit 1\n',
    );
    chmodSync(path.join(oldBin, 'node'), 0o755);

    const result = run(['start', '--port', String(port), '--tunnel-ack'], {
      BDBOARD_SERVER_CALLER: 'chair',
      PATH: `${oldBin}:${env.PATH}`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('node の版チェックを実行できませんでした');
    expect(result.stderr).toContain('node v14.15.0');
    expect(result.stderr).toContain("SyntaxError: Unexpected token '||='"); // チェッカーの出力も見せる
    expect(result.stderr).toContain('サーバーは触っていません');
    expect(result.stdout).not.toContain('== starting');
    expect(listenerPid()).toBeNull();
  }, 60_000);
});

// bdboard-5st4: 停止前の build 成果物ゲート。2026-09-26 の事故 (bdboard-qoxg) では、build:web が
// 古い node で exit 0 を返したのに web/dist/index.html は古いまま残り、build-meta.json だけが HEAD の sha に
// 更新されていた (write-build-meta が vite build の後に走るため)。終了コードも build-meta.json の sha も
// 当てにならないので、build の後・旧 listener の停止の前に index.html 自体が今回の build で更新されたかを見る。
// 偽の build:web (FAKE_BUILD_MODE で成果物の作り方を切り替える) と偽サーバーで、restart --build と
// deploy が旧 listener を止める前に exit 2 で止まること、更新された build は従来どおり進むことを確かめる。
// Windows は上の describe と同じく skip (bash / lsof / nohup 前提)。mtime の比較ロジック自体は
// node で書いた build-artifact-check.mjs にあり、そちらの単体テストは Windows でも走る。
const FAKE_BUILD = `
const fs = require('node:fs');
const path = require('node:path');
const mode = process.env.FAKE_BUILD_MODE || 'fresh';
const dist = path.join(process.cwd(), 'web', 'dist');
if (mode === 'fail') { console.error('fake build:web failed'); process.exit(1); }
fs.mkdirSync(dist, { recursive: true });
if (mode === 'fresh') fs.writeFileSync(path.join(dist, 'index.html'), '<html>fresh</html>');
if (mode === 'wipe') fs.rmSync(path.join(dist, 'index.html'), { force: true });
// 'stale' = 事故の形: build-meta.json だけ新しくなり、exit 0 のまま index.html は古いまま。
fs.writeFileSync(path.join(dist, 'build-meta.json'), JSON.stringify({ sha: 'head', builtAt: new Date().toISOString() }));
`;

describe.skipIf(process.platform === 'win32' || !hasPortTool())('always-on-server.sh build artifact gate', () => {
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

  function chair(args, mode = 'fresh') {
    return run(args, { BDBOARD_SERVER_CALLER: 'chair', FAKE_BUILD_MODE: mode });
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

  const indexHtml = () => path.join(repo, 'web', 'dist', 'index.html');

  // 前の build が作った index.html を 1 時間前のものにする (今回の build より確実に古い)。
  function seedOldIndexHtml() {
    const old = new Date(Date.now() - 3_600_000);
    mkdirSync(path.dirname(indexHtml()), { recursive: true });
    writeFileSync(indexHtml(), '<html>old</html>');
    utimesSync(indexHtml(), old, old);
  }

  function restartBuild(pid, mode) {
    return chair(['restart', '--port', String(port), '--expect-pid', String(pid), '--build', '--tunnel-ack'], mode);
  }

  function expectUntouched(result, pid, logBefore) {
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('サーバーは触っていません');
    expect(result.stdout).not.toContain('== stopping');
    expect(result.stdout).not.toContain('== starting');
    expect(listenerPid()).toBe(pid);
    expect(run(['status', '--port', String(port)]).stdout).toContain('HTTP 200');
    expect(readFileSync(env.BDBOARD_SERVER_LOG, 'utf8')).toBe(logBefore);
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-always-on-build-gate-'));
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
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'server.js'), FAKE_SERVER);
    writeFileSync(path.join(repo, 'build-web.js'), FAKE_BUILD);
    writeFileSync(path.join(repo, '.gitignore'), 'web/dist/\n'); // 成果物は追跡しない (pull と衝突させない)
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: 'fake-bdboard',
        private: true,
        engines: { node: '>=1.0.0' },
        scripts: { start: 'node server.js', 'build:web': 'node build-web.js' },
      }),
    );
    seedOldIndexHtml();
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

  it('--dry-run announces the artifact check after build:web, and omits it with --no-build', () => {
    const started = chair(['start', '--port', String(port), '--tunnel-ack']);
    expect(started.status, started.stderr).toBe(0);
    const pid = listenerPid();
    expect(pid).not.toBeNull();

    const dry = chair(['restart', '--port', String(port), '--expect-pid', String(pid), '--build', '--dry-run', '--tunnel-ack']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('[dry-run] build:web mode=always');
    expect(dry.stdout).toContain('[dry-run] build:web の後');
    expect(dry.stdout).toContain('web/dist/index.html');
    expect(dry.stdout).toContain('exit 2');

    const noBuild = chair(['restart', '--port', String(port), '--expect-pid', String(pid), '--no-build', '--dry-run', '--tunnel-ack']);
    expect(noBuild.status).toBe(0);
    expect(noBuild.stdout).toContain('[dry-run] build:web mode=never');
    expect(noBuild.stdout).not.toContain('[dry-run] build:web の後');
    expect(listenerPid()).toBe(pid);
  }, 60_000);

  it('restart --build stops before the listener when build:web exits 0 but leaves index.html stale (the 2026-09-26 shape)', () => {
    const pid = listenerPid();
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    seedOldIndexHtml();

    const result = restartBuild(pid, 'stale');

    expect(result.stdout).toContain('== npm run build:web');
    expectUntouched(result, pid, logBefore);
    expect(result.stderr).toContain('index.html');
    expect(result.stderr).toContain('今回の build');
    expect(result.stderr).toContain('同じコマンドを再実行');
    expect(result.stderr).not.toContain('deploy の再実行ではなく');
    expect(readFileSync(indexHtml(), 'utf8')).toBe('<html>old</html>');
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('result=build-artifact-stale');
  }, 60_000);

  it('restart --build stops before the listener when build:web exits 0 but removed index.html', () => {
    const pid = listenerPid();
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    seedOldIndexHtml();

    const result = restartBuild(pid, 'wipe');

    expectUntouched(result, pid, logBefore);
    expect(result.stderr).toContain('index.html');
    expect(result.stderr).toContain('ありません');
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('result=build-artifact-stale');
  }, 60_000);

  it('a build:web that exits non-zero is still reported as build-failed', () => {
    const pid = listenerPid();
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    seedOldIndexHtml();

    const result = restartBuild(pid, 'fail');

    expectUntouched(result, pid, logBefore);
    expect(result.stderr).toContain('npm run build:web に失敗しました');
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('result=build-failed');
  }, 60_000);

  it('deploy stops before the listener when the build it triggered left index.html stale; the same deploy then recovers', () => {
    const pid = listenerPid();
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    seedOldIndexHtml();
    mkdirSync(path.join(other, 'web', 'src'), { recursive: true });
    writeFileSync(path.join(other, 'web', 'src', 'App.tsx'), '// web change\n');
    commitAll(other, 'web change');
    git(other, 'push', '-q', 'origin', 'main');
    const originHead = git(other, 'rev-parse', 'HEAD');

    const result = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack'], 'stale');

    expect(result.stdout).toContain('== npm run build:web');
    expectUntouched(result, pid, logBefore);
    expect(result.stderr).toContain('index.html');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originHead); // pull は済んでいる
    const audit = readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8');
    expect(audit).toMatch(/\tdeploy\tcaller=chair\t[^\n]*result=build-artifact-stale/);

    // 案内どおり同じ deploy を打ち直せば入れ直せる (build が今度は index.html を作る。bdboard-oga4:
    // 以前は OLD_HEAD == NEW_HEAD で「変更なし」になり、restart --build を案内していた)。
    expect(result.stderr).toContain('同じコマンドを再実行');
    const recovered = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack'], 'fresh');
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).not.toContain('server-side unchanged');
    expect(recovered.stdout).toContain(`== OK: PID ${pid} ->`);
    expect(readFileSync(indexHtml(), 'utf8')).toBe('<html>fresh</html>');
    expect(listenerPid()).not.toBe(pid);
  }, 90_000);

  it('proceeds as before when build:web refreshes index.html', () => {
    const pid = listenerPid();
    seedOldIndexHtml();

    const result = restartBuild(pid, 'fresh');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('== npm run build:web');
    expect(result.stdout).toContain('== stopping');
    expect(result.stdout).toContain(`== OK: PID ${pid} ->`);
    expect(readFileSync(indexHtml(), 'utf8')).toBe('<html>fresh</html>');
    expect(listenerPid()).not.toBe(pid);
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('result=ok');
  }, 60_000);
});

// bdboard-oga4: pull の後・旧 listener の停止の前に止まった deploy (build:web の失敗・build 成果物が古い・
// node 版ゲートなど) は、以前は同じコマンドを再実行しても OLD_HEAD == NEW_HEAD で「変更なし」と判定され、
// マージしたコードが反映されないまま exit 0 の成功扱いになった。いまは「最後にデプロイに成功した sha」
// (監査ログの横の状態ファイル) からの差分で install / build / 再起動の要否を決めるので、停止の前に
// 止まった deploy は原因 (環境) を直して同じコマンドを打ち直せば最後まで進む。
// 偽の build:web (FAKE_BUILD_MODE) と偽サーバー、origin (bare) から clone した使い捨てリポジトリで確かめる。
describe.skipIf(process.platform === 'win32' || !hasPortTool())('always-on-server.sh deploy retry after an early stop', () => {
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

  function chair(args, mode = 'fresh') {
    return run(args, { BDBOARD_SERVER_CALLER: 'chair', FAKE_BUILD_MODE: mode });
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

  const indexHtml = () => path.join(repo, 'web', 'dist', 'index.html');
  const deployedFile = () => `${env.BDBOARD_SERVER_AUDIT_LOG}.deployed-head`;
  const savedSha = () => readFileSync(deployedFile(), 'utf8').split('\t')[0];
  const deploy = (pid, mode) =>
    chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--tunnel-ack'], mode);

  // 前の build が作った index.html を 1 時間前のものにする (今回の build より確実に古い)。
  function seedOldIndexHtml() {
    const old = new Date(Date.now() - 3_600_000);
    mkdirSync(path.dirname(indexHtml()), { recursive: true });
    writeFileSync(indexHtml(), '<html>old</html>');
    utimesSync(indexHtml(), old, old);
  }

  // origin に web/ だけを変えるコミットを 1 つ足し、その sha を返す。
  function pushWebChange(label) {
    mkdirSync(path.join(other, 'web', 'src'), { recursive: true });
    writeFileSync(path.join(other, 'web', 'src', 'App.tsx'), `// ${label}\n`);
    commitAll(other, label);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-always-on-retry-'));
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
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'server.js'), FAKE_SERVER);
    writeFileSync(path.join(repo, 'build-web.js'), FAKE_BUILD);
    writeFileSync(path.join(repo, '.gitignore'), 'web/dist/\n');
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: 'fake-bdboard',
        private: true,
        engines: { node: '>=1.0.0' },
        scripts: { start: 'node server.js', 'build:web': 'node build-web.js' },
      }),
    );
    seedOldIndexHtml();
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

  it('a deploy stopped by a failing build:web is completed by running the same command again', () => {
    const started = chair(['start', '--port', String(port), '--tunnel-ack']);
    expect(started.status, started.stderr).toBe(0);
    const pid = listenerPid();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');
    expect(run(['status', '--port', String(port)]).stdout).toContain('deployed HEAD : (記録なし');
    const head1 = pushWebChange('web change 1');

    const failed = deploy(pid, 'fail');

    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain('npm run build:web に失敗しました');
    expect(failed.stderr).toContain('同じコマンドを再実行');
    expect(failed.stdout).not.toContain('== stopping');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head1); // pull は済んでいる
    expect(listenerPid()).toBe(pid);
    expect(readFileSync(env.BDBOARD_SERVER_LOG, 'utf8')).toBe(logBefore);
    expect(readFileSync(indexHtml(), 'utf8')).toBe('<html>old</html>');
    // 停止前に止まったので「デプロイ成功」は記録されない (初回は pull 前の HEAD を起点として残す)。
    expect(savedSha()).toBe(headBefore);

    // 原因 (環境) を直した = build が通る。コミットは足さず、同じコマンドを打ち直す。
    const retried = deploy(pid, 'fresh');

    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.stdout).not.toContain('server-side unchanged');
    expect(retried.stdout).toContain('== npm run build:web');
    expect(retried.stdout).toContain('== stopping');
    expect(retried.stdout).toContain(`== OK: PID ${pid} ->`);
    expect(readFileSync(indexHtml(), 'utf8')).toBe('<html>fresh</html>');
    expect(listenerPid()).not.toBe(pid);
    expect(savedSha()).toBe(head1);
    expect(run(['status', '--port', String(port)]).stdout).toContain(`deployed HEAD : ${head1.slice(0, 7)}`);
  }, 120_000);

  it('a deploy on an already deployed HEAD does nothing and says so', () => {
    const pid = listenerPid();
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');

    const again = deploy(pid, 'fresh');

    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('nothing to deploy');
    expect(again.stdout).toContain(`PID ${pid}`);
    expect(again.stdout).not.toContain('== npm run build:web');
    expect(again.stdout).not.toContain('== stopping');
    expect(listenerPid()).toBe(pid);
    expect(readFileSync(env.BDBOARD_SERVER_LOG, 'utf8')).toBe(logBefore);
    expect(readFileSync(env.BDBOARD_SERVER_AUDIT_LOG, 'utf8')).toContain('result=no-restart-needed');

    const dry = chair(['deploy', '--port', String(port), '--expect-pid', String(pid), '--dry-run', '--tunnel-ack']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`最後にデプロイに成功した sha (${savedSha().slice(0, 7)})`);
  }, 60_000);

  it('a deploy stopped by a stale build artifact is also completed by the same command', () => {
    const pid = listenerPid();
    seedOldIndexHtml();
    const head2 = pushWebChange('web change 2');

    const stopped = deploy(pid, 'stale');

    expect(stopped.status).toBe(2);
    expect(stopped.stderr).toContain('index.html');
    expect(stopped.stderr).toContain('同じコマンドを再実行');
    expect(stopped.stderr).not.toContain('deploy の再実行ではなく');
    expect(stopped.stdout).not.toContain('== stopping');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head2);
    expect(listenerPid()).toBe(pid);
    expect(savedSha()).not.toBe(head2);

    const retried = deploy(pid, 'fresh');

    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.stdout).not.toContain('server-side unchanged');
    expect(retried.stdout).toContain(`== OK: PID ${pid} ->`);
    expect(readFileSync(indexHtml(), 'utf8')).toBe('<html>fresh</html>');
    expect(savedSha()).toBe(head2);
  }, 120_000);

  it('restart --pull --no-build does not record the sha, so the next deploy still builds it', () => {
    const pid = listenerPid();
    const recorded = savedSha();
    const head3 = pushWebChange('web change 3');

    const skipped = chair(
      ['restart', '--port', String(port), '--expect-pid', String(pid), '--pull', '--no-build', '--tunnel-ack'],
      'fresh',
    );

    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).not.toContain('== npm run build:web');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head3);
    expect(savedSha()).toBe(recorded); // build を飛ばしたので「デプロイ済み」にはしない
    const pid2 = listenerPid();
    expect(pid2).not.toBe(pid);

    const deployed = deploy(pid2, 'fresh');

    expect(deployed.status, deployed.stderr).toBe(0);
    expect(deployed.stdout).toContain('== npm run build:web');
    expect(deployed.stdout).toContain(`== OK: PID ${pid2} ->`);
    expect(savedSha()).toBe(head3);
  }, 120_000);

  it('ignores a saved sha that names an unknown commit or another checkout', () => {
    const pid = listenerPid();
    const head = git(repo, 'rev-parse', 'HEAD');
    const logBefore = readFileSync(env.BDBOARD_SERVER_LOG, 'utf8');

    // スクリプトの MAIN は `pwd -P` なので、macOS の /var → /private/var も解決した path で書く
    // (書かないとパスの不一致で弾かれ、未知の sha の分岐を通らない)。
    const unknownRecord = `${'0'.repeat(40)}\t${realpathSync(repo)}\n`;
    writeFileSync(deployedFile(), unknownRecord);
    const unknown = deploy(pid, 'fresh');
    expect(unknown.status, unknown.stderr).toBe(0);
    expect(unknown.stdout).toContain('server-side unchanged');
    expect(unknown.stdout).not.toContain('== npm run build:web');
    // 記録が無く pull も何もしなかった実行は、HEAD を「デプロイ済み」として記録せず、復旧手順を案内する。
    expect(unknown.stdout).toContain(`restart --expect-pid ${pid} --build`);
    expect(readFileSync(deployedFile(), 'utf8')).toBe(unknownRecord);

    // 実在する sha でも、別の checkout が書いたものは起点にしない (起点にしていれば HEAD と同じなので
    // "nothing to deploy" になるはず)。
    writeFileSync(deployedFile(), `${head}\t${path.join(tmpRoot, 'somewhere-else')}\n`);
    const foreign = deploy(pid, 'fresh');
    expect(foreign.status, foreign.stderr).toBe(0);
    expect(foreign.stdout).toContain('server-side unchanged');
    expect(foreign.stdout).not.toContain('nothing to deploy');

    expect(listenerPid()).toBe(pid);
    expect(readFileSync(env.BDBOARD_SERVER_LOG, 'utf8')).toBe(logBefore);
  }, 60_000);
});
