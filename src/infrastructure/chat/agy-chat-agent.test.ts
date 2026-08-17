import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createAgyChatAgent } from './agy-chat-agent.js';

function runner(capture: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv }): CommandRunner {
  return { async run(command, args, options): Promise<CommandResult> { capture.command = command; capture.args = args; capture.env = options?.env; return { stdout: JSON.stringify({ conversation_id: 'session-1', status: 'SUCCESS', response: 'ok' }), stderr: '', exitCode: 0 }; } };
}

describe('createAgyChatAgent (bdboard-l1t.6)', () => {
  it('builds the agy descriptor, filters env, and sends a message', async () => {
    const capture: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv } = {};
    // bdPath はデフォルト解決が process.env.BDBOARD_BD_PATH を読むため(N1)、テストを
    // 実行環境の env に依存させない(ヘルメティックに保つ)よう明示的に固定する。
    const agent = createAgyChatAgent(runner(capture), { agyPath: '/opt/agy', bdPath: 'bd', model: 'gemini', env: { PATH: '/bin', HOME: '/tmp/home', SECRET: 'hidden' } });
    expect(agent.descriptor).toMatchObject({ id: 'agy', label: 'Antigravity CLI', capability: 'unrestricted', experimental: true, model: 'gemini' });
    const result = await agent.sendMessage({ projectRootPath: '/tmp/demo', projectName: 'demo', message: 'hi' });
    expect(result.reply).toBe('ok');
    expect(capture.command).toBe('/opt/agy');
    expect(capture.args?.[0]).toContain('--print=');
    // agy フレーバーのシステムプロンプトが実際にプロンプトトークンへ載っていること
    // (bdboard-l1t.6): headless 自動拒否の説明と、引用しない bd -C 案内。
    expect(capture.args?.[0]).toContain('自動拒否');
    expect(capture.args?.[0]).toContain('bd -C "/tmp/demo"');
    expect(capture.args?.[0]).not.toContain('--sandbox enabled');
    expect(capture.env).toEqual({ PATH: '/bin', HOME: '/tmp/home' });
  });
});
