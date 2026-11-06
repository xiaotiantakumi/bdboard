import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsHarnessInjector } from './fs-harness-injector.js';
import { createFsPackRegistry } from './fs-pack-registry.js';
import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  runHarnessUninject,
  type UninjectCliIo,
} from './harness-uninject-cli.js';

describe('runHarnessUninject', () => {
  let tmpDir: string;
  let packsRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-uninject-cli-'));
    packsRoot = path.join(tmpDir, 'bdboard', 'harness', 'packs');
    projectRoot = path.join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    for (const [name, extra] of [
      ['base-pack', { role: 'base' }],
      ['video-pack', { role: 'optional', requires: ['base-pack'] }],
    ] as const) {
      const packDir = path.join(packsRoot, name);
      mkdirSync(path.join(packDir, 'hooks'), { recursive: true });
      writeFileSync(
        path.join(packDir, 'pack.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          description: name,
          ...extra,
          hooks: [{ event: 'Stop', script: 'hooks/run.sh' }],
        }),
        'utf8',
      );
      writeFileSync(path.join(packDir, 'SKILL.md'), `# ${name}\n`, 'utf8');
      writeFileSync(path.join(packDir, 'hooks/run.sh'), 'exit 0\n', 'utf8');
    }
    const registry = createFsPackRegistry(packsRoot);
    const injector = createFsHarnessInjector({ packsRoot });
    for (const name of ['base-pack', 'video-pack']) {
      const pack = await registry.getPack(name);
      await injector.injectPack(projectRoot, pack!, new Date('2026-11-06T00:00:00Z'));
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(
    argv: string[],
    stdinIsTty: boolean,
    options: { insideAgent?: boolean; ttyAnswer?: string | null } = {},
  ): Promise<{ code: number; out: string; err: string; asked: string[] }> {
    let out = '';
    let err = '';
    const asked: string[] = [];
    const io: UninjectCliIo = {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      stdinIsTty,
      insideAgent: options.insideAgent ?? false,
      askTty: (question) => {
        asked.push(question);
        // 既定は正しいパック名を答える (引数の --pack と同じ)。
        const pack = argv[argv.indexOf('--pack') + 1] ?? '';
        return Promise.resolve(options.ttyAnswer === undefined ? pack : options.ttyAnswer);
      },
    };
    return runHarnessUninject(argv, io, packsRoot).then((code) => ({ code, out, err, asked }));
  }

  const skillFile = (name: string): string =>
    path.join(projectRoot, '.claude/skills', name, 'SKILL.md');

  it('is a dry-run by default: lists what would go and changes nothing', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack'], true);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('video-pack');
    expect(result.out).toContain('.claude/skills/video-pack/SKILL.md');
    expect(result.out).toContain('dry-run');
    expect(existsSync(skillFile('video-pack'))).toBe(true);
  });

  it('allows the dry-run without a TTY (it only prints)', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack'], false);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(skillFile('video-pack'))).toBe(true);
  });

  it('refuses --yes without a TTY, tells the user to run it in their own terminal, and changes nothing', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack', '--yes'], false);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toContain('ユーザーが自分の端末');
    expect(existsSync(skillFile('video-pack'))).toBe(true);
  });

  it('removes the pack with --yes on a TTY and says commits are left to the user', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack', '--yes'], true);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('コミットは別途');
    expect(existsSync(skillFile('video-pack'))).toBe(false);
    expect(existsSync(skillFile('base-pack'))).toBe(true);
  });

  it('refuses --yes inside Claude Code (CLAUDECODE set) even on a TTY, and tells the user to use a normal terminal', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack', '--yes'], true, {
      insideAgent: true,
    });

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toContain('Claude Code の外');
    expect(result.asked).toEqual([]);
    expect(existsSync(skillFile('video-pack'))).toBe(true);
  });

  it('allows the dry-run inside Claude Code (it only prints)', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack'], false, {
      insideAgent: true,
    });

    expect(result.code).toBe(EXIT_OK);
  });

  it('asks the user to type the pack name after the list, and removes nothing when the answer differs', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack', '--yes'], true, {
      ttyAnswer: 'something-else',
    });

    expect(result.asked).toHaveLength(1);
    expect(result.asked[0]).toContain('video-pack');
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain('一致しません');
    expect(existsSync(skillFile('video-pack'))).toBe(true);
  });

  it('refuses (changes nothing) when the controlling terminal cannot be opened for the confirmation', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'video-pack', '--yes'], true, {
      ttyAnswer: null,
    });

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toContain('/dev/tty');
    expect(existsSync(skillFile('video-pack'))).toBe(true);
  });

  it('refuses a pack unknown to the registry by default and accepts --allow-unresolved', async () => {
    const manifestPath = path.join(projectRoot, '.claude/bdboard-packs.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packs: unknown[] };
    manifest.packs.push({ name: 'ghost-pack', version: '1', injectedAt: '2026-11-06T00:00:00Z', files: [] });
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const refused = await run(['--project', projectRoot, '--pack', 'video-pack'], false);
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err).toContain('--allow-unresolved');

    const allowed = await run(['--project', projectRoot, '--pack', 'video-pack', '--allow-unresolved'], false);
    expect(allowed.code).toBe(EXIT_OK);
    expect(allowed.out).toContain('ghost-pack');
  });

  it('refuses removing the base while an optional pack that requires it is injected (even with --yes on a TTY)', async () => {
    const result = await run(['--project', projectRoot, '--pack', 'base-pack', '--yes'], true);

    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain('video-pack');
    expect(existsSync(skillFile('base-pack'))).toBe(true);
  });

  it('refuses a self-injection target', async () => {
    const selfRoot = path.join(tmpDir, 'bdboard');
    const registry = createFsPackRegistry(packsRoot);
    await createFsHarnessInjector({ packsRoot }).injectPack(
      selfRoot,
      (await registry.getPack('base-pack'))!,
      new Date('2026-11-06T00:00:00Z'),
    );

    const result = await run(['--project', selfRoot, '--pack', 'base-pack', '--yes'], true);

    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain('self-injection');
  });

  it('prints usage and exits with the usage code for missing or unknown arguments', async () => {
    expect((await run(['--pack', 'base-pack'], true)).code).toBe(EXIT_USAGE);
    expect((await run(['--project', projectRoot, '--pack', 'base-pack', '--force'], true)).code).toBe(
      EXIT_USAGE,
    );
    expect((await run(['--project', projectRoot, '--pack'], true)).code).toBe(EXIT_USAGE);
  });
});
