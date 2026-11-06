import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  ): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const io: UninjectCliIo = {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      stdinIsTty,
    };
    return runHarnessUninject(argv, io, packsRoot).then((code) => ({ code, out, err }));
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
