// bdboard-cdoj: scripts/deploy-changed.sh の deploy 再起動判定を単体テストする。
// 一時 Git リポジトリでコミットを重ね、スクリプトを直接実行して確認する。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./deploy-changed.sh', import.meta.url));

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

describe.skipIf(process.platform === 'win32' || !hasGit())('deploy-changed.sh', () => {
  let tmpRoot;
  let repo;
  let env;

  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  function commit(message) {
    git('add', '-A');
    git(
      '-c', 'user.name=bdboard-test',
      '-c', 'user.email=bdboard-test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', message,
    );
    return git('rev-parse', 'HEAD').trim();
  }

  // 判定結果 (true = 再起動が要る) を返す。スクリプトの終了コードは 0 (再起動要) か
  // 1 (不要) のどちらかであるべきで、それ以外 (構文エラー・source 失敗等) はテストの
  // バグとして失敗させる — 想定外の exit code をこっそり「変更なし」扱いにしない。
  function relevantChanged(oldSha, newSha, ...paths) {
    const result = spawnSync('bash', [SCRIPT, repo, oldSha, newSha, '--', ...paths], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.stderr).toBe('');
    expect([0, 1]).toContain(result.status);
    return result.status === 0;
  }

  // always-on-server.sh の実際の deploy 呼び出しが渡す pathspec を、deploy-changed.sh の
  // DEPLOY_RESTART_PATHSPEC 配列をそのまま source して読む (bdboard-kpim レビュー指摘: ここへ
  // リテラルを複製すると、呼び出し側の pathspec を変えてもテストが書き換え忘れに気付けない)。
  function restartPathspec() {
    const result = spawnSync(
      'bash',
      ['-c', '. "$1" && printf \'%s\\n\' "${DEPLOY_RESTART_PATHSPEC[@]}"', '_', SCRIPT],
      { encoding: 'utf8', timeout: 10_000 },
    );
    if (result.status !== 0) {
      throw new Error(`failed to read DEPLOY_RESTART_PATHSPEC from ${SCRIPT}: ${result.stderr}`);
    }
    return result.stdout.split('\n').filter((line) => line.length > 0);
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-deploy-changed-'));
    repo = path.join(tmpRoot, 'repo');
    env = { ...process.env, HOME: path.join(tmpRoot, 'home'), CDPATH: '' };
    mkdirSync(env.HOME, { recursive: true });
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(repo, 'package.json'), '{"name":"fake"}\n');
    git('init', '-q');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports no relevant change when OLD and NEW are the same commit', () => {
    const head = commit('init');
    expect(relevantChanged(head, head, 'src/', 'package.json', 'package-lock.json', '.env')).toBe(
      false,
    );
  });

  it('excludes test files and test-only directories', () => {
    const oldSha = commit('init');
    mkdirSync(path.join(repo, 'src', '__fixtures__'), { recursive: true });
    mkdirSync(path.join(repo, 'src', 'foo-test-support'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'a.test.ts'), '// test\n');
    writeFileSync(path.join(repo, 'src', 'b.test.mjs'), '// test\n');
    writeFileSync(path.join(repo, 'src', 'c.test.tsx'), '// test\n');
    writeFileSync(path.join(repo, 'src', '__fixtures__', 'sample.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(repo, 'src', 'foo-test-support', 'helper.ts'), 'export const y = 1;\n');
    const newSha = commit('test-only change');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(false);
  });

  it('reports a relevant change when a real src/ file changes alongside test files', () => {
    const oldSha = commit('init');
    writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(repo, 'src', 'a.test.ts'), '// test\n');
    const newSha = commit('real change with test');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(true);
  });

  it('reports a relevant change when package.json changes', () => {
    const oldSha = commit('init');
    writeFileSync(path.join(repo, 'package.json'), '{"name":"fake","version":"2.0.0"}\n');
    const newSha = commit('bump version');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(true);
  });

  it('does not exclude a real file whose name merely contains "test-support" unanchored', () => {
    // レビュー指摘: アンカー無しパターンだと "latest-support.ts" のような無関係な本物の
    // ファイル名まで誤って除外してしまう ("la" + "test-support")。これはテスト専用
    // ディレクトリでも *.test.* でもない、実際のサーバーコードのつもりの変更。
    const oldSha = commit('init');
    writeFileSync(path.join(repo, 'src', 'latest-support.ts'), 'export const z = 1;\n');
    const newSha = commit('add latest-support.ts');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(true);
  });

  it('reports a relevant change when a real file is renamed into a test-support directory', () => {
    // レビュー指摘: rename detection が有効だと `git diff --name-only` は移動先のパスしか
    // 出さない。非テストファイルを test-support/ 配下へ rename しただけでも、内容は
    // そのまま実行され続けるので「変更なし」と誤判定してはいけない (--no-renames で防ぐ)。
    const oldSha = commit('init');
    mkdirSync(path.join(repo, 'src', 'foo-test-support'), { recursive: true });
    git('mv', 'src/index.ts', 'src/foo-test-support/index.ts');
    const newSha = commit('rename real file into test-support dir');
    expect(
      relevantChanged(oldSha, newSha, 'src/', 'package.json', 'package-lock.json', '.env'),
    ).toBe(true);
  });

  // bdboard-kpim: src/bootstrap/wire-feature-routes.ts の SPA フォールバックは
  // web/dist/index.html を起動時に 1 回だけ読むため、web/ だけの変更でも再起動が必要
  // (DEPLOY_RESTART_PATHSPEC が src/ package.json package-lock.json .env に加えて web/ と
  // docs/help-content.json も持つようになった)。
  it('reports a relevant change when a real web/ file changes', () => {
    const oldSha = commit('init');
    mkdirSync(path.join(repo, 'web', 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'web', 'src', 'main.tsx'), 'export const App = () => null;\n');
    const newSha = commit('add web/src/main.tsx');
    expect(relevantChanged(oldSha, newSha, ...restartPathspec())).toBe(true);
  });

  it('does not report a relevant change when only a web/ test file changes', () => {
    const oldSha = commit('init');
    mkdirSync(path.join(repo, 'web', 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'web', 'src', 'App.test.tsx'), '// test\n');
    const newSha = commit('add web/src/App.test.tsx');
    expect(relevantChanged(oldSha, newSha, ...restartPathspec())).toBe(false);
  });

  // src/infrastructure/chat/help-content.ts と web/src/helpContent.ts (web バンドルへ直接
  // import) も docs/help-content.json を起動時/ビルド時に 1 回だけ読むため、この JSON だけの
  // 変更でも再起動が必要。
  it('reports a relevant change when docs/help-content.json changes', () => {
    const oldSha = commit('init');
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'help-content.json'), '{"sections":[]}\n');
    const newSha = commit('add docs/help-content.json');
    expect(relevantChanged(oldSha, newSha, ...restartPathspec())).toBe(true);
  });
});
