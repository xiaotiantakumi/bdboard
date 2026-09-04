import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import {
  HarnessInjectionError,
  HarnessPathTraversalError,
} from '../../application/ports/harness-injector.js';
import { SETTINGS_RELATIVE_PATH } from '../../domain/harness-hooks.js';
import {
  GITIGNORE_MANAGED_HEADER,
  MANIFEST_RELATIVE_PATH,
} from '../../domain/harness-path.js';
import { createFsHarnessInjector } from './fs-harness-injector.js';

describe('createFsHarnessInjector', () => {
  let tmpDir: string;
  let packsRoot: string;
  let projectRoot: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function setupFixture(): ReturnType<typeof createFsHarnessInjector> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-inject-'));
    packsRoot = path.join(tmpDir, 'packs');
    projectRoot = path.join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    return createFsHarnessInjector({ packsRoot });
  }

  /**
   * 注入先が「パック原本を抱えている repo 自身」になる配置 (bdboard-x32)。
   * packsRoot を projectRoot の内側に置くことで自己再注入を再現する。
   */
  function setupSelfInjectionFixture(): ReturnType<typeof createFsHarnessInjector> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-self-'));
    projectRoot = path.join(tmpDir, 'bdboard');
    packsRoot = path.join(projectRoot, 'harness', 'packs');
    mkdirSync(packsRoot, { recursive: true });
    return createFsHarnessInjector({ packsRoot });
  }

  function writePack(
    name: string,
    version: string,
    files: Record<string, string>,
  ): void {
    const packDir = path.join(packsRoot, name);
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({ name, version, description: `${name} pack` }),
      'utf8',
    );
    for (const [relativePath, content] of Object.entries(files)) {
      const absolute = path.join(packDir, relativePath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
  }

  it('copies pack files into .claude/skills and writes manifest', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', {
      'SKILL.md': '# harness',
      'references/a.md': 'reference',
    });

    const manifest = await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }, { relativePath: 'references/a.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    expect(existsSync(path.join(projectRoot, '.claude/skills/bdboard-harness/SKILL.md'))).toBe(
      true,
    );
    expect(
      readFileSync(
        path.join(projectRoot, '.claude/skills/bdboard-harness/SKILL.md'),
        'utf8',
      ),
    ).toBe('# harness');
    expect(manifest.packs).toEqual([
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        injectedAt: '2026-08-16T10:00:00.000Z',
        files: [
          '.claude/skills/bdboard-harness/SKILL.md',
          '.claude/skills/bdboard-harness/references/a.md',
        ],
        hooks: [],
      },
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(projectRoot, '.claude/bdboard-packs.json'), 'utf8'),
      ),
    ).toEqual(manifest);
  });

  it('removes stale files from a previous install of the same pack', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', {
      'SKILL.md': '# v1',
      'references/old.md': 'old',
    });
    writePack('bdboard-harness', '0.2.0', {
      'SKILL.md': '# v2',
      'references/new.md': 'new',
    });

    await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }, { relativePath: 'references/old.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    const manifest = await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.2.0',
        description: 'test',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }, { relativePath: 'references/new.md' }],
      },
      new Date('2026-08-16T11:00:00.000Z'),
    );

    expect(
      existsSync(path.join(projectRoot, '.claude/skills/bdboard-harness/references/old.md')),
    ).toBe(false);
    expect(
      existsSync(path.join(projectRoot, '.claude/skills/bdboard-harness/references/new.md')),
    ).toBe(true);
    expect(manifest.packs[0]?.files).toEqual([
      '.claude/skills/bdboard-harness/SKILL.md',
      '.claude/skills/bdboard-harness/references/new.md',
    ]);
  });

  it('preserves manifest entries for other packs', async () => {
    const injector = setupFixture();
    writePack('alpha-pack', '1.0.0', { 'SKILL.md': '# alpha' });
    writePack('beta-pack', '1.0.0', { 'SKILL.md': '# beta' });

    await injector.injectPack(
      projectRoot,
      {
        name: 'alpha-pack',
        version: '1.0.0',
        description: 'alpha',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T09:00:00.000Z'),
    );

    const manifest = await injector.injectPack(
      projectRoot,
      {
        name: 'beta-pack',
        version: '1.0.0',
        description: 'beta',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    expect(manifest.packs).toEqual([
      {
        name: 'alpha-pack',
        version: '1.0.0',
        injectedAt: '2026-08-16T09:00:00.000Z',
        files: ['.claude/skills/alpha-pack/SKILL.md'],
        hooks: [],
      },
      {
        name: 'beta-pack',
        version: '1.0.0',
        injectedAt: '2026-08-16T10:00:00.000Z',
        files: ['.claude/skills/beta-pack/SKILL.md'],
        hooks: [],
      },
    ]);
  });

  it('rejects stale removal paths outside .claude/', async () => {
    const injector = setupFixture();
    writePack('evil-pack', '1.0.0', { 'SKILL.md': '# evil' });
    const manifestPath = path.join(projectRoot, '.claude/bdboard-packs.json');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        packs: [
          {
            name: 'evil-pack',
            version: '0.9.0',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: ['src/escape.txt'],
          },
        ],
      }),
      'utf8',
    );
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/escape.txt'), 'secret', 'utf8');

    await expect(
      injector.injectPack(
        projectRoot,
        {
          name: 'evil-pack',
          version: '1.0.0',
          description: 'evil',
          hooks: [],
          files: [{ relativePath: 'SKILL.md' }],
        },
        new Date('2026-08-16T10:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(HarnessPathTraversalError);
    expect(existsSync(path.join(projectRoot, 'src/escape.txt'))).toBe(true);
  });

  it('rejects pack file paths that escape the destination tree', async () => {
    const injector = setupFixture();
    writePack('evil-pack', '1.0.0', { 'SKILL.md': '# evil' });

    await expect(
      injector.injectPack(
        projectRoot,
        {
          name: 'evil-pack',
          version: '1.0.0',
          description: 'evil',
          hooks: [],
          files: [{ relativePath: '../outside.md' }],
        },
        new Date('2026-08-16T10:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(HarnessPathTraversalError);
    expect(existsSync(path.join(projectRoot, 'outside.md'))).toBe(false);
  });

  it('returns empty manifest when manifest file is missing or invalid', async () => {
    const injector = setupFixture();
    expect(await injector.readManifest(projectRoot)).toEqual({ packs: [] });

    mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.claude/bdboard-packs.json'), '{bad', 'utf8');
    expect(await injector.readManifest(projectRoot)).toEqual({ packs: [] });
  });

  it('creates .gitignore with manifest and pack entries when missing', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', { 'SKILL.md': '# harness' });

    await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain(GITIGNORE_MANAGED_HEADER);
    expect(gitignore).toContain(MANIFEST_RELATIVE_PATH);
    expect(gitignore).toContain('.claude/skills/bdboard-harness/');
  });

  it('appends gitignore entries without modifying existing content', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', { 'SKILL.md': '# harness' });
    writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

    await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(gitignore.startsWith('node_modules/\ndist/\n')).toBe(true);
    expect(gitignore).toContain(GITIGNORE_MANAGED_HEADER);
    expect(gitignore).toContain(MANIFEST_RELATIVE_PATH);
    expect(gitignore).toContain('.claude/skills/bdboard-harness/');
  });

  it('does not duplicate gitignore entries on repeated injection of the same pack', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', { 'SKILL.md': '# v1' });
    writePack('bdboard-harness', '0.2.0', { 'SKILL.md': '# v2' });

    const pack = {
      name: 'bdboard-harness',
      version: '0.1.0',
      description: 'test',
      hooks: [],
      files: [{ relativePath: 'SKILL.md' }],
    };

    await injector.injectPack(projectRoot, pack, new Date('2026-08-16T10:00:00.000Z'));
    await injector.injectPack(
      projectRoot,
      { ...pack, version: '0.2.0' },
      new Date('2026-08-16T11:00:00.000Z'),
    );

    const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').filter((line) => line.length > 0);
    expect(lines.filter((line) => line === GITIGNORE_MANAGED_HEADER)).toHaveLength(1);
    expect(lines.filter((line) => line === MANIFEST_RELATIVE_PATH)).toHaveLength(1);
    expect(lines.filter((line) => line === '.claude/skills/bdboard-harness/')).toHaveLength(1);
  });

  it('adds separate gitignore lines per pack without duplicating the header', async () => {
    const injector = setupFixture();
    writePack('alpha-pack', '1.0.0', { 'SKILL.md': '# alpha' });
    writePack('beta-pack', '1.0.0', { 'SKILL.md': '# beta' });

    await injector.injectPack(
      projectRoot,
      {
        name: 'alpha-pack',
        version: '1.0.0',
        description: 'alpha',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T09:00:00.000Z'),
    );
    await injector.injectPack(
      projectRoot,
      {
        name: 'beta-pack',
        version: '1.0.0',
        description: 'beta',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').filter((line) => line.length > 0);
    expect(lines.filter((line) => line === GITIGNORE_MANAGED_HEADER)).toHaveLength(1);
    expect(lines.filter((line) => line === MANIFEST_RELATIVE_PATH)).toHaveLength(1);
    expect(lines.filter((line) => line === '.claude/skills/alpha-pack/')).toHaveLength(1);
    expect(lines.filter((line) => line === '.claude/skills/beta-pack/')).toHaveLength(1);
  });

  it('does not touch .gitignore when injecting into the repo that owns the packs (bdboard-x32)', async () => {
    const injector = setupSelfInjectionFixture();
    writePack('bdboard-harness', '0.1.0', {
      'SKILL.md': '# harness',
    });
    writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

    await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'harness',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-29T09:00:00.000Z'),
    );

    // 注入自体は行われる — 抑止するのは .gitignore への追記だけ。
    expect(
      existsSync(path.join(projectRoot, '.claude', 'skills', 'bdboard-harness', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(path.join(projectRoot, MANIFEST_RELATIVE_PATH))).toBe(true);

    const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(gitignore).toBe('node_modules/\ndist/\n');
    expect(gitignore).not.toContain(GITIGNORE_MANAGED_HEADER);
    expect(gitignore).not.toContain(MANIFEST_RELATIVE_PATH);
  });

  it('does not create a .gitignore on self-injection when none exists (bdboard-x32)', async () => {
    const injector = setupSelfInjectionFixture();
    writePack('bdboard-harness', '0.1.0', {
      'SKILL.md': '# harness',
    });

    await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'harness',
        hooks: [],
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-29T09:00:00.000Z'),
    );

    expect(existsSync(path.join(projectRoot, '.gitignore'))).toBe(false);
  });


  // Windows の symlink 作成には権限が要るので、そこでは走らせない。
  it.skipIf(process.platform === 'win32')(
    'detects self-injection through a symlinked project path (bdboard-x32)',
    async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-symlink-'));
      const realProjectRoot = path.join(tmpDir, 'real-bdboard');
      packsRoot = path.join(realProjectRoot, 'harness', 'packs');
      mkdirSync(packsRoot, { recursive: true });
      // 同じ場所を指す別表記でプロジェクトが登録されている状況 (macOS の
      // /var -> /private/var など) を symlink で再現する。
      const linkedProjectRoot = path.join(tmpDir, 'linked-bdboard');
      symlinkSync(realProjectRoot, linkedProjectRoot, 'dir');
      projectRoot = linkedProjectRoot;

      const injector = createFsHarnessInjector({ packsRoot });
      writePack('bdboard-harness', '0.1.0', {
        'SKILL.md': '# harness',
      });
      writeFileSync(path.join(realProjectRoot, '.gitignore'), 'node_modules/\n', 'utf8');

      await injector.injectPack(
        linkedProjectRoot,
        {
          name: 'bdboard-harness',
          version: '0.1.0',
          description: 'harness',
          hooks: [],
          files: [{ relativePath: 'SKILL.md' }],
        },
        new Date('2026-08-29T09:00:00.000Z'),
      );

      const gitignore = readFileSync(path.join(realProjectRoot, '.gitignore'), 'utf8');
      expect(gitignore).toBe('node_modules/\n');
    },
  );

  describe('hook registration (bdboard-pkr6.2)', () => {
    const HOOKED_PACK = {
      name: 'bdboard-harness',
      version: '0.1.0',
      description: 'test',
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          script: 'hooks/pre-bash-guard.sh',
          timeout: 10,
        },
        { event: 'Stop', matcher: '', script: 'hooks/stop-ticket-gate.sh', timeout: 20 },
      ],
      files: [
        { relativePath: 'SKILL.md' },
        { relativePath: 'hooks/pre-bash-guard.sh' },
        { relativePath: 'hooks/stop-ticket-gate.sh' },
      ],
    } as const;

    // 「呼ばれたら 3」で終わる。存在チェック付きラッパが実体を実行したのか
    // 黙って抜けたのか (= 0) を終了コードで区別するため。
    function writeHookedPack(): void {
      writePack('bdboard-harness', '0.1.0', {
        'SKILL.md': '# harness',
        'hooks/pre-bash-guard.sh': '#!/usr/bin/env bash\nexit 3\n',
        'hooks/stop-ticket-gate.sh': '#!/usr/bin/env bash\nexit 3\n',
      });
    }

    function settingsPath(): string {
      return path.join(projectRoot, SETTINGS_RELATIVE_PATH);
    }

    it('registers declared hooks in .claude/settings.json', async () => {
      const injector = setupFixture();
      writeHookedPack();

      const manifest = await injector.injectPack(
        projectRoot,
        HOOKED_PACK,
        new Date('2026-09-04T10:00:00.000Z'),
      );

      const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
      expect(settings.hooks.PreToolUse).toEqual([
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/pre-bash-guard.sh"`,
              timeout: 10,
            },
          ],
        },
      ]);
      expect(settings.hooks.Stop[0].matcher).toBeUndefined();
      expect(manifest.packs[0]?.hooks).toEqual([
        `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/pre-bash-guard.sh"`,
        `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/stop-ticket-gate.sh"`,
      ]);
    });

    it.skipIf(process.platform === 'win32')(
      'makes copied hooks/*.sh executable, even on re-injection',
      async () => {
        const injector = setupFixture();
        writeHookedPack();
        // 先に実行ビットの無いコピーを置く: copyFile は既存ファイルの mode を
        // 引き継ぐので、上書き注入でも chmod が要ることを固定する。
        const destination = path.join(
          projectRoot,
          '.claude/skills/bdboard-harness/hooks/pre-bash-guard.sh',
        );
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, 'old\n', { encoding: 'utf8', mode: 0o644 });

        await injector.injectPack(
          projectRoot,
          HOOKED_PACK,
          new Date('2026-09-04T10:00:00.000Z'),
        );

        expect(() => accessSync(destination, fsConstants.X_OK)).not.toThrow();
        expect(statSync(destination).mode & 0o777).toBe(0o755);
        // hooks/ の外は実行ビットを立てない。
        expect(
          statSync(path.join(projectRoot, '.claude/skills/bdboard-harness/SKILL.md')).mode &
            0o111,
        ).toBe(0);
      },
    );

    it('keeps existing settings and is idempotent across re-injection', async () => {
      const injector = setupFixture();
      writeHookedPack();
      mkdirSync(path.dirname(settingsPath()), { recursive: true });
      writeFileSync(
        settingsPath(),
        `${JSON.stringify(
          {
            hooks: {
              SessionStart: [
                { hooks: [{ command: 'node ./scripts/x.mjs', type: 'command' }], matcher: '' },
              ],
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      await injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T10:00:00.000Z'));
      const first = readFileSync(settingsPath(), 'utf8');
      await injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T11:00:00.000Z'));
      const second = readFileSync(settingsPath(), 'utf8');

      expect(second).toBe(first);
      expect(JSON.parse(second).hooks.SessionStart).toEqual([
        { hooks: [{ command: 'node ./scripts/x.mjs', type: 'command' }], matcher: '' },
      ]);
    });

    it('fails the injection and writes no manifest when settings.json is broken', async () => {
      const injector = setupFixture();
      writeHookedPack();
      mkdirSync(path.dirname(settingsPath()), { recursive: true });
      writeFileSync(settingsPath(), '{ "hooks": ', 'utf8');

      await expect(
        injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T10:00:00.000Z')),
      ).rejects.toBeInstanceOf(HarnessInjectionError);

      expect(existsSync(path.join(projectRoot, MANIFEST_RELATIVE_PATH))).toBe(false);
      // 人が書いた設定は潰さない。
      expect(readFileSync(settingsPath(), 'utf8')).toBe('{ "hooks": ');
    });

    it('does not create settings.json for a pack without hooks', async () => {
      const injector = setupFixture();
      writePack('plain-pack', '0.1.0', { 'SKILL.md': '# plain' });

      await injector.injectPack(
        projectRoot,
        {
          name: 'plain-pack',
          version: '0.1.0',
          description: 'plain',
          hooks: [],
          files: [{ relativePath: 'SKILL.md' }],
        },
        new Date('2026-09-04T10:00:00.000Z'),
      );

      expect(existsSync(settingsPath())).toBe(false);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'fails the injection when settings.json exists but cannot be read',
      async () => {
        // EACCES を ENOENT と同じ「無い」に丸めると、既存の設定が丸ごと消える。
        const injector = setupFixture();
        writeHookedPack();
        mkdirSync(path.dirname(settingsPath()), { recursive: true });
        const original = `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`;
        writeFileSync(settingsPath(), original, 'utf8');
        chmodSync(settingsPath(), 0o000);

        try {
          await expect(
            injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T10:00:00.000Z')),
          ).rejects.toBeInstanceOf(HarnessInjectionError);

          expect(existsSync(path.join(projectRoot, MANIFEST_RELATIVE_PATH))).toBe(false);
        } finally {
          chmodSync(settingsPath(), 0o644);
        }

        expect(readFileSync(settingsPath(), 'utf8')).toBe(original);
      },
    );

    it('does not rewrite settings.json when the merge changes nothing', async () => {
      const injector = setupFixture();
      writeHookedPack();

      await injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T10:00:00.000Z'));
      const firstMtime = statSync(settingsPath()).mtimeMs;

      await injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T11:00:00.000Z'));

      expect(statSync(settingsPath()).mtimeMs).toBe(firstMtime);
    });

    it.skipIf(process.platform === 'win32')(
      'registers a command that runs the hook, and exits 0 when it is absent',
      async () => {
        // 注入コピーが .gitignore される注入先では、settings.json だけがコミット
        // された repo をクローンすると hook 本体が無い。そこで毎ターン exit 127 の
        // stderr を出さないことを、実際にシェルへ通して確かめる。
        const injector = setupFixture();
        writeHookedPack();
        const manifest = await injector.injectPack(
          projectRoot,
          HOOKED_PACK,
          new Date('2026-09-04T10:00:00.000Z'),
        );
        const command = manifest.packs[0]?.hooks?.[0];
        expect(command).toBeDefined();

        // 子プロセス生成は infrastructure/process の runner 経由で行う
        // (child_process の直 import は境界ルールで禁止されている)。
        const runner = new NodeCommandRunner();
        const invoke = async (projectDir: string) =>
          runner.run('bash', ['-c', command as string], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_PROJECT_DIR: projectDir },
          });

        // 本体があるときは実体が走る (fixture は exit 3)。
        expect((await invoke(projectRoot)).exitCode).toBe(3);

        // 本体が無いときは成功で抜け、hook 由来のエラーを出さない。stderr の完全一致は
        // 見ない — 実行環境 (サンドボックス等) が独自の警告を混ぜることがあるので、
        // 「exit 127 / No such file をこのパスについて出さない」ことだけを固定する。
        const emptyRoot = path.join(tmpDir, 'clone-without-skills');
        mkdirSync(emptyRoot, { recursive: true });
        const absent = await invoke(emptyRoot);
        expect(absent.exitCode).toBe(0);
        expect(absent.stderr).not.toContain('.claude/skills');
        expect(absent.stderr).not.toContain('No such file');
      },
    );

    it('reads back the settings file through readSettings', async () => {
      const injector = setupFixture();
      writeHookedPack();

      expect(await injector.readSettings(projectRoot)).toBeNull();
      await injector.injectPack(projectRoot, HOOKED_PACK, new Date('2026-09-04T10:00:00.000Z'));
      expect(await injector.readSettings(projectRoot)).toContain('pre-bash-guard.sh');
    });
  });
});
