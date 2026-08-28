import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
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
  //
  // その置き場所を決めているのは本番配線であるこのファイルなので、不変条件はここで固定する。
  // codex-spec.test.ts 側では scratchDir をテスト自身が作って注入するため、あちらで
  // os.tmpdir() を assert しても検証できるのはテストの組み立てだけで、製品の挙動ではない。
  it('places CLI scratch artifacts under os.tmpdir()', async () => {
    let capturedArgs: string[] = [];
    const runner: CommandRunner = {
      async run(_command, args) {
        capturedArgs = [...args];
        writeFileSync(args[args.indexOf('-o') + 1]!, 'reply', 'utf8');
        return {
          stdout: JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
          stderr: '',
          exitCode: 0,
        };
      },
    };

    await createCodexChatAgent(runner).sendMessage(request());

    const lastMessageFile = capturedArgs[capturedArgs.indexOf('-o') + 1]!;
    expect(path.dirname(lastMessageFile)).toBe(os.tmpdir());
  });
});
