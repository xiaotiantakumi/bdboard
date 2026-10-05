import { describe, expect, it } from 'vitest';
import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliExternalRefReader } from './bd-cli-external-ref-reader.js';

const ROOT = '/root/proj';
const EXPECTED_ARGS = [
  '--readonly',
  '-C',
  ROOT,
  'list',
  '--all',
  '--json',
  '--limit',
  '0',
  '--brief',
  '--no-pager',
];
const WRITE_VERBS = ['create', 'update', 'comment', 'close', 'delete', 'dolt'];

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

function createFakeRunner(result: CommandResult): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    run(command, args, options) {
      calls.push({ command, args, options });
      return Promise.resolve(result);
    },
  };
  return { runner, calls };
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });

describe('createBdCliExternalRefReader', () => {
  it('passes the expected read-only arguments (--readonly -C <root> ... --no-pager)', async () => {
    const { runner, calls } = createFakeRunner(ok('[]'));

    await createBdCliExternalRefReader(runner, { bdPath: '/usr/bin/bd' }).listExternalRefs(ROOT);

    expect(calls).toEqual([{ command: '/usr/bin/bd', args: EXPECTED_ARGS, options: { timeoutMs: 30_000 } }]);
    for (const verb of WRITE_VERBS) {
      expect(calls[0].args).not.toContain(verb);
    }
  });

  it('reads external_ref from an array and keeps only string values', async () => {
    const { runner } = createFakeRunner(
      ok(
        JSON.stringify([
          { id: 'a', external_ref: 'gh-1' },
          { id: 'b', external_ref: null },
          { id: 'c' },
          { id: 'd', external_ref: 42 },
          'not an object',
          null,
          { id: 'e', external_ref: 'https://github.com/xiaotiantakumi/bdboard/issues/2' },
        ]),
      ),
    );

    expect(await createBdCliExternalRefReader(runner).listExternalRefs(ROOT)).toEqual([
      'gh-1',
      'https://github.com/xiaotiantakumi/bdboard/issues/2',
    ]);
  });

  it('accepts an {issues: [...]} payload', async () => {
    const { runner } = createFakeRunner(ok(JSON.stringify({ issues: [{ external_ref: 'gh-3' }] })));

    expect(await createBdCliExternalRefReader(runner).listExternalRefs(ROOT)).toEqual(['gh-3']);
  });

  it('returns an empty list for an empty array, an empty issues list, or an empty stdout', async () => {
    for (const stdout of ['[]', '{"issues":[]}', '', '  \n']) {
      const { runner } = createFakeRunner(ok(stdout));
      expect(await createBdCliExternalRefReader(runner).listExternalRefs(ROOT)).toEqual([]);
    }
  });

  it.each(['not json', '{"items":[]}', '{"issues":"nope"}', '42', 'null'])(
    'throws a schema-mismatch BdError for %j',
    async (stdout) => {
      const { runner } = createFakeRunner(ok(stdout));

      const error = await createBdCliExternalRefReader(runner)
        .listExternalRefs(ROOT)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BdError);
      expect(error).toMatchObject({ kind: 'schema-mismatch' });
    },
  );

  it('throws a timeout BdError when the runner reports a timeout', async () => {
    const { runner } = createFakeRunner({ stdout: '', stderr: '', exitCode: -1, failureKind: 'timeout' });

    const error = await createBdCliExternalRefReader(runner, { timeoutMs: 5 })
      .listExternalRefs(ROOT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BdError);
    expect(error).toMatchObject({ kind: 'timeout' });
  });

  it('throws a BdError for any other non-zero exit', async () => {
    const { runner } = createFakeRunner({ stdout: '', stderr: 'something broke', exitCode: 1 });

    await expect(createBdCliExternalRefReader(runner).listExternalRefs(ROOT)).rejects.toBeInstanceOf(BdError);
  });
});
