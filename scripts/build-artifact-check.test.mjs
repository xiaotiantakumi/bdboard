// bdboard-5st4: build-artifact-check.mjs (always-on-server.sh の停止前 build 成果物ゲート) のテスト。
// mtime の比較は node で書いてあり bash / lsof に依存しないので、always-on-server.test.mjs と違って
// Windows でも走る。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_STALE, EXIT_UNAVAILABLE, checkArtifact, formatStaleLines, main } from './build-artifact-check.mjs';

const script = fileURLToPath(new URL('./build-artifact-check.mjs', import.meta.url));

const tempDirs = [];
const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-artifact-check-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const at = (file, epochSeconds) => {
  const when = new Date(epochSeconds * 1000);
  fs.utimesSync(file, when, when);
};

// stamp は 2026-10-03T00:00:00Z。artifact の mtime だけを変えて判定を見る。
const STAMP_SEC = Date.UTC(2026, 9, 3) / 1000;

const makeFiles = ({ artifactContent = '<html></html>', artifactSec }) => {
  const dir = makeTempDir();
  const stamp = path.join(dir, 'build-started');
  const artifact = path.join(dir, 'index.html');
  fs.writeFileSync(stamp, '');
  at(stamp, STAMP_SEC);
  if (artifactSec !== undefined) {
    fs.writeFileSync(artifact, artifactContent);
    at(artifact, artifactSec);
  }
  return { dir, stamp, artifact };
};

describe('checkArtifact', () => {
  it('accepts an artifact written after the stamp', () => {
    const { stamp, artifact } = makeFiles({ artifactSec: STAMP_SEC + 30 });
    expect(checkArtifact({ artifact, stamp })).toEqual({ ok: true });
  });

  it('accepts an artifact in the same second as the stamp (a fast build, or a coarser filesystem)', () => {
    const { stamp, artifact } = makeFiles({ artifactSec: STAMP_SEC });
    expect(checkArtifact({ artifact, stamp })).toEqual({ ok: true });
  });

  it('rejects an artifact left over from before the stamp (the 2026-09-26 shape: exit 0, index.html untouched)', () => {
    const { stamp, artifact } = makeFiles({ artifactSec: STAMP_SEC - 3600 });
    const result = checkArtifact({ artifact, stamp });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale');
    expect(result.artifactMtime).toBe('2026-10-02T23:00:00.000Z');
    expect(result.stampMtime).toBe('2026-10-03T00:00:00.000Z');
  });

  it('rejects a missing artifact', () => {
    const { stamp, artifact } = makeFiles({});
    expect(checkArtifact({ artifact, stamp })).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('rejects an empty artifact even when it is new', () => {
    const { stamp, artifact } = makeFiles({ artifactContent: '', artifactSec: STAMP_SEC + 30 });
    expect(checkArtifact({ artifact, stamp })).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects an artifact that is a directory', () => {
    const { dir, stamp } = makeFiles({});
    const artifact = path.join(dir, 'index.html');
    fs.mkdirSync(artifact);
    at(artifact, STAMP_SEC + 30);
    expect(checkArtifact({ artifact, stamp })).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('throws when the stamp cannot be read, so the caller can fail closed', () => {
    const { dir, artifact } = makeFiles({ artifactSec: STAMP_SEC + 30 });
    expect(() => checkArtifact({ artifact, stamp: path.join(dir, 'no-such-stamp') })).toThrow();
  });
});

describe('formatStaleLines', () => {
  it('names the artifact, both times, and the likely cause for a stale file', () => {
    const { stamp, artifact } = makeFiles({ artifactSec: STAMP_SEC - 3600 });
    const text = formatStaleLines(checkArtifact({ artifact, stamp })).join('\n');
    expect(text).toContain(artifact);
    expect(text).toContain('2026-10-02T23:00:00.000Z');
    expect(text).toContain('2026-10-03T00:00:00.000Z');
    expect(text).toContain('bdboard-qoxg');
    for (const line of text.split('\n')) {
      expect(line.startsWith('always-on-server: ')).toBe(true);
    }
  });

  it('says the file is missing for a missing artifact', () => {
    const { stamp, artifact } = makeFiles({});
    expect(formatStaleLines(checkArtifact({ artifact, stamp })).join('\n')).toContain('がありません');
  });
});

describe('main / command line', () => {
  it('returns the exit codes the shell script relies on', () => {
    const io = { stdout: { write: () => true }, stderr: { write: () => true } };
    const fresh = makeFiles({ artifactSec: STAMP_SEC + 30 });
    expect(main([fresh.artifact, fresh.stamp], io)).toBe(EXIT_OK);
    const stale = makeFiles({ artifactSec: STAMP_SEC - 3600 });
    expect(main([stale.artifact, stale.stamp], io)).toBe(EXIT_STALE);
    expect(main(['only-one-argument'], io)).toBe(EXIT_UNAVAILABLE);
    expect([EXIT_OK, EXIT_STALE, EXIT_UNAVAILABLE]).toEqual([0, 3, 1]);
  });

  it('exits 0 silently for a fresh artifact, 3 with an explanation for a stale one, and 1 when the stamp is unreadable', () => {
    const run = (artifact, stamp) => {
      const result = spawnSync(process.execPath, [script, artifact, stamp], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const fresh = makeFiles({ artifactSec: STAMP_SEC + 30 });
    expect(run(fresh.artifact, fresh.stamp)).toEqual({ status: 0, stdout: '', stderr: '' });

    const stale = makeFiles({ artifactSec: STAMP_SEC - 3600 });
    const staleResult = run(stale.artifact, stale.stamp);
    expect(staleResult.status).toBe(3);
    expect(staleResult.stdout).toContain('今回の build:web の開始');

    const unreadable = run(fresh.artifact, path.join(fresh.dir, 'no-such-stamp'));
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain('build-artifact-check:');
  });
});
