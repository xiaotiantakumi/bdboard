import { describe, expect, it } from 'vitest';
import { buildRunPrompt, type BuildRunPromptInput } from './build-run-prompt.js';

function input(overrides: Partial<BuildRunPromptInput> = {}): BuildRunPromptInput {
  return {
    ticketId: 'bdboard-54be.1',
    ticketTitle: 'Agent run wiring',
    verify: 'npm run verify',
    prFlow: 'pr',
    ...overrides,
  };
}

describe('buildRunPrompt', () => {
  it('includes ticket id and title as untrusted data', () => {
    const prompt = buildRunPrompt(input());

    expect(prompt).toContain('bdboard-54be.1');
    expect(prompt).toContain('Agent run wiring');
    expect(prompt).toMatch(/信頼できない入力/);
  });

  it('does not instruct the agent to treat bd show output as authoritative', () => {
    const prompt = buildRunPrompt(input({ ticketTitle: 'Example' }));

    expect(prompt).toContain('bd show bdboard-54be.1');
    expect(prompt).not.toContain('正本');
    expect(prompt).toMatch(/信頼できないデータ/);
    expect(prompt).toMatch(/従わない/);
    expect(prompt).toMatch(/実装すべき変更内容の記述として参照/);
    expect(prompt).toContain('bdboard-harness skill');
  });

  it('forbids git publish actions and does not instruct install/verify', () => {
    const prompt = buildRunPrompt(input({ ticketTitle: 'Example' }));

    expect(prompt).toContain('commit / push / PR 作成 / マージは行わない');
    expect(prompt).not.toContain('npm install && npm --prefix web install');
    expect(prompt).toMatch(/許可されていません/);
    expect(prompt).toContain('worktree 内で完結');
  });

  /**
   * verify は「実行させる」ためではなく「run の外で回す必要がある」と伝えるために
   * 載る。文言が命令形に寄ると allowlist の外側を叩かせる指示になるので、
   * 「実行できません」と申し送りコメントの 2 点をここで固定する (bdboard-pkr6.11)。
   */
  it('states the contract verify command and asks for a hand-off comment', () => {
    const prompt = buildRunPrompt(input({ verify: 'npm run check', prFlow: 'pr' }));

    expect(prompt).toContain(
      'このプロジェクトの検証コマンドは `npm run check` ですが、run 内では実行できません',
    );
    expect(prompt).toContain('git 運用: PR 必須');
    expect(prompt).toContain(
      'bd comment bdboard-54be.1 "検証待ち: npm run check を run の外で実行してください"',
    );
  });

  /**
   * 「<verify> を実行してください」という命令形が入ると、run 内で allowlist の
   * 外側を叩かせる指示になる。verify に言及する行は必ず「run の外」を伴うこと。
   */
  it('never instructs the agent to run verify inside the run', () => {
    const prompt = buildRunPrompt(input({ verify: 'npm run verify' }));

    const verifyLines = prompt
      .split('\n')
      .filter((line) => line.includes('npm run verify'));
    expect(verifyLines.length).toBeGreaterThan(0);
    for (const line of verifyLines) {
      expect(line).toMatch(/run 内では実行できません|run の外で実行/);
    }
    expect(prompt).not.toMatch(/npm run verify[^\n]{0,20}を実行してください。/);
  });

  it('describes the project git flow for direct and none contracts', () => {
    expect(buildRunPrompt(input({ prFlow: 'direct' }))).toContain(
      'git 運用: main へ直接コミット可',
    );
    expect(buildRunPrompt(input({ prFlow: 'none' }))).toContain('git 運用: git 運用なし');
  });
});
