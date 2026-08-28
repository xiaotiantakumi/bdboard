import os from 'node:os';
import path from 'node:path';
import { statSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatTurnRequest } from '../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { createCodexChatAgent } from './codex-chat-agent.js';

const request = (overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({
  projectRootPath: '/tmp/demo',
  projectName: 'demo',
  message: 'hello',
  ...overrides,
});

describe('createCodexChatAgent scratch directory (bdboard-che)', () => {
  // Windows では画像一時ファイルのモード指定 (0o600) が効かず、秘匿性の根拠が
  // 「ファイルの置き場所が os.tmpdir() = 既定でユーザープロファイル配下の %TEMP% である」
  // ことだけになる (codex-spec.ts の writeImageFiles 上のコメント参照)。
  // bdboard-jp3 以降、応答ファイル (last-message.txt) は os.tmpdir() 直下ではなく
  // 0700 のターンディレクトリ内に置かれるが、Windows ではその 0700 も効かないので、
  // %TEMP% の既定 ACL への依拠が引き続き根拠である。
  //
  // その置き場所を決めているのは本番配線であるこのファイルなので、不変条件はここで固定する。
  // codex-spec.test.ts 側では scratchDir をテスト自身が作って注入するため、あちらで
  // os.tmpdir() を assert しても検証できるのはテストの組み立てだけで、製品の挙動ではない。
  it('places CLI lastMessageFile inside a per-turn directory under os.tmpdir() (bdboard-jp3)', async () => {
    let capturedArgs: string[] = [];
    let turnDirMode: number | undefined;
    const runner: CommandRunner = {
      async run(_command, args) {
        capturedArgs = [...args];
        const lastMessageFile = args[args.indexOf('-o') + 1]!;
        const turnDir = path.dirname(lastMessageFile);
        if (process.platform !== 'win32') {
          turnDirMode = statSync(turnDir).mode & 0o777;
        }
        writeFileSync(lastMessageFile, 'reply', 'utf8');
        return {
          stdout: JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
          stderr: '',
          exitCode: 0,
        };
      },
    };

    await createCodexChatAgent(runner).sendMessage(request());

    const lastMessageFile = capturedArgs[capturedArgs.indexOf('-o') + 1]!;
    expect(path.dirname(lastMessageFile)).not.toBe(os.tmpdir());
    expect(path.dirname(path.dirname(lastMessageFile))).toBe(os.tmpdir());
    if (process.platform !== 'win32') {
      expect(turnDirMode).toBe(0o700);
    }
  });
});
