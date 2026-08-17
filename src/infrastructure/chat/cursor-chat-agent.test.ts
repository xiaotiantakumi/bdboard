import { describe, expect, it, vi } from 'vitest';
import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import { createCursorChatAgent } from './cursor-chat-agent.js';

function createFakeRunner(
  handler: (
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ) => Promise<CommandResult> | CommandResult,
): CommandRunner {
  return {
    async run(command, args, runOptions) {
      return await handler(command, args, runOptions);
    },
  };
}

// bdboard-l1t.5 Opus 再レビュー DF7: SF6(a) の resume-session-id ミスマッチ警告は
// cli-chat-agent.test.ts でダミー spec を使って汎用に固定してあるが、cursor アダプタは
// 実際に --resume へでたらめな id を渡してもエラーにならず別 session_id を返す
// サイレントフォールバック挙動が実測で確認されている(cursor-spec.ts の buildCursorArgs
// コメント参照)ため、cursor 経路を通しても同じ警告が発火することを別途固定する。
describe('createCursorChatAgent resume session-id mismatch warning (DF7)', () => {
  it('warns when --resume gets a stale/unknown session id and cursor-agent silently starts a new session', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = createFakeRunner(async (_command, args) => {
      expect(args).toContain('--resume');
      expect(args[args.indexOf('--resume') + 1]).toBe('stale-session-id');
      // cursor-agent の実測挙動: 未知の resume id を渡してもエラーにはならず、
      // その id をそのまま session_id として返しつつ実際には新規セッションとして
      // 応答する(サイレントフォールバック)。ここでは代わりに、実測どおりの
      // 「別の(新規)session_id を返す」ケースを再現して警告の発火を確認する。
      return {
        stdout: JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'continuing as if resumed',
          session_id: 'brand-new-session-id',
        }),
        stderr: '',
        exitCode: 0,
      };
    });

    const agent = createCursorChatAgent(runner, { cursorPath: 'cursor-agent' });
    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'continue please',
      resumeSessionId: 'stale-session-id',
    });

    expect(result.sessionId).toBe('brand-new-session-id');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnedText = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnedText).toContain('stale-session-id');
    expect(warnedText).toContain('brand-new-session-id');
    expect(warnedText).toContain('cursor');

    warnSpy.mockRestore();
  });

  it('does not warn on a normal resume where the session id matches', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({
      stdout: JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'ok',
        session_id: 'matching-session-id',
      }),
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCursorChatAgent(runner, { cursorPath: 'cursor-agent' });
    await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'continue please',
      resumeSessionId: 'matching-session-id',
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
