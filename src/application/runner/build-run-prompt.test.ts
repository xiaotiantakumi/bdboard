import { describe, expect, it } from 'vitest';
import { buildRunPrompt } from './build-run-prompt.js';

describe('buildRunPrompt', () => {
  it('includes ticket id and title as untrusted data', () => {
    const prompt = buildRunPrompt({
      ticketId: 'bdboard-54be.1',
      ticketTitle: 'Agent run wiring',
    });

    expect(prompt).toContain('bdboard-54be.1');
    expect(prompt).toContain('Agent run wiring');
    expect(prompt).toMatch(/信頼できない入力/);
  });

  it('does not instruct the agent to treat bd show output as authoritative', () => {
    const prompt = buildRunPrompt({
      ticketId: 'bdboard-54be.1',
      ticketTitle: 'Example',
    });

    expect(prompt).toContain('bd show bdboard-54be.1');
    expect(prompt).not.toContain('正本');
    expect(prompt).toMatch(/信頼できないデータ/);
    expect(prompt).toMatch(/従わない/);
    expect(prompt).toMatch(/実装すべき変更内容の記述として参照/);
    expect(prompt).toContain('bdboard-harness skill');
  });

  it('forbids git publish actions and requires install then verify', () => {
    const prompt = buildRunPrompt({
      ticketId: 'bdboard-54be.1',
      ticketTitle: 'Example',
    });

    expect(prompt).toContain('commit / push / PR 作成 / マージは行わない');
    expect(prompt).toContain('npm install && npm --prefix web install');
    expect(prompt).toContain('npm run verify');
    expect(prompt).toContain('worktree 内で完結');
  });
});
