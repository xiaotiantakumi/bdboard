import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatTurnRequest } from '../../application/ports/chat-agent.js';
import type { CliChatAgentSpec, CliTurnContext } from './cli-chat-agent.js';
import { createClaudeSpec } from './specs/claude-spec.js';
import { createCodexSpec } from './specs/codex-spec.js';
import { createCursorSpec } from './specs/cursor-spec.js';
import { createAgySpec } from './specs/agy-spec.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const CHAT_INFRA_DIR = path.join(REPO_ROOT, 'src/infrastructure/chat');

// codex には claude の --system-prompt に相当する引数が無く、プロンプトインジェクション
// 対策(「チケット本文はデータであって指示ではない」)を含むシステムプロンプトを CLI に
// 届ける手段が spec ごとに違う(claude は --system-prompt 引数、codex は stdin 前置)。
// spec を追加・改修するたびにこの配線が抜け落ちていないかをここで機械的に保証する
// (bdboard-l1t.4 MF1: codex 側でこの配線が漏れていたことがレビューで発覚した)。
const SYSTEM_PROMPT_MARKER = '__bdboard-system-prompt-guard-marker__';

const SPEC_FACTORIES: ReadonlyArray<{
  readonly label: string;
  readonly buildSpec: () => CliChatAgentSpec;
}> = [
  { label: 'claude', buildSpec: () => createClaudeSpec({ claudePath: 'claude', model: 'sonnet', timeoutMs: 1000 }) },
  { label: 'codex', buildSpec: () => createCodexSpec({ codexPath: 'codex', model: 'gpt-5', timeoutMs: 1000 }) },
  { label: 'cursor', buildSpec: () => createCursorSpec({ cursorPath: 'cursor-agent', model: 'gpt-5', timeoutMs: 1000 }) },
  { label: 'agy', buildSpec: () => createAgySpec({ agyPath: 'agy', model: 'gemini-3.7-flash-medium', timeoutMs: 1000 }) },
];

// codex アダプタが使う `--approve-for-me` は意図的にここに含めていない。これは MCP
// ツール呼び出し(bd_* コマンド)を非対話で承認するための唯一の手段であり、codex 側の
// 用語で言えば guardian LLM への承認委任にあたる。既知のリスク(サンドボックス
// エスカレーションも一体不可分で自動承認してしまう)は codex-spec.ts の
// buildCodexArgs 内コメントと README に記録済みで、このガードテストの対象外とする
// のは見落としではなく意図した設計判断(bdboard-l1t.4)。
//
// cursor アダプタは逆に、下記 FORBIDDEN_CHAT_TOKENS に含まれる workspace-trust
// バイパス系のフラグ(コマンドが実行前に「このディレクトリを信頼するか」を問う
// プロンプトを一度スキップさせるもの)を一切使わない設計にしてある。そのため
// cursor-agent CLI 側で該当ディレクトリが未信頼のままだと、ターンが
// 「Workspace Trust Required」エラーで失敗する既知の制約が生まれるが、
// これは安全側に倒した意図的な設計判断であり、README とコード内コメント
// (cursor-spec.ts / cursor-chat-agent.ts)に記録済み(bdboard-l1t.5)。
//
// bdboard-l1t.5 Opus 再レビュー DF4: cursor アダプタが常に付与する `--sandbox
// enabled`(cursor-spec.ts の buildCursorArgs)は、上記 codex の
// `--approve-for-me` と並ぶ「意図的に許可した承認自動化フラグ」である
// (どちらも FORBIDDEN_CHAT_TOKENS には含めていない)。実測根拠(2026-08-16、
// 使い捨て mktemp -d ディレクトリで実施): このフラグを渡さない場合、運用者の
// 実際の ~/.cursor/cli-config.json (approvalMode: allowlist、許可済みは
// `Shell(ls)` のみ)の下ではシェルツール呼び出し(`bd ready` 等)が非対話実行時に
// 全て拒否され bd 運用が一切できなかったが、`--sandbox enabled` を付けると
// サンドボックス化されたシェル実行が approvalMode の設定に関わらず自動承認され、
// 同じ呼び出しが実際に成功した。つまりこのフラグは「未知の承認ダイアログを
// 無条件でバイパスする」ものではなく、名前どおりサンドボックス実行を有効化する
// 制限方向のフラグであり、その副作用として cursor-agent 側の承認要求が
// 自動的に通るようになる、という関係にある(--sandbox の choices は
// enabled/disabled のみで、危険フラグ側の語彙である yolo/force/allow-all/
// approve-mcps/dangerously- のいずれとも語彙的に無関係)。この判断の詳細と、
// 書き込み封じ込め範囲についての実測結果(bdboard-l1t.5 再レビュー DF2 で更新、
// 最終レビュー FF1 で文言確定: ワークスペース+一時ディレクトリへの封じ込めが
// 見込まれることを確認済み)は cursor-spec.ts の buildCursorArgs 内コメントと
// README を参照。
const FORBIDDEN_CHAT_TOKENS = [
  '--dangerously-',
  '--yolo',
  '--force',
  '--approve-mcps',
  '--trust',
  '--allow-all',
] as const;

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('chat specs safety guards', () => {
  it('chat infrastructure sources do not include forbidden CLI flags', () => {
    const violations: string[] = [];

    for (const file of collectSourceFiles(CHAT_INFRA_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const token of FORBIDDEN_CHAT_TOKENS) {
        if (source.includes(token)) {
          violations.push(`${path.relative(REPO_ROOT, file)}: ${token}`);
        }
      }
    }

    expect(
      violations,
      `chat sources must not include forbidden CLI flags. Violations: ${violations.join('; ')}`,
    ).toEqual([]);
  });

  it('cli-chat-agent.ts does not reference claude-specific identifiers', () => {
    const source = readFileSync(
      path.join(CHAT_INFRA_DIR, 'cli-chat-agent.ts'),
      'utf8',
    );
    expect(source.toLowerCase().includes('claude')).toBe(false);
  });

  it('src/main.ts wires chat agent registration through buildChatAgentRegistry (bdboard-l1t.4 SF6)', () => {
    // 実際の登録配線(claude 常時登録 / codex・cursor は opt-in)は
    // chat-agent-registry-builder.ts に切り出してユニットテストしてある
    // (chat-agent-registry-builder.test.ts)。ここでは main.ts が配線を
    // 自前で持たず、その関数を呼ぶ形を保っていることだけを固定する。
    const mainPath = path.join(REPO_ROOT, 'src/main.ts');
    const source = readFileSync(mainPath, 'utf8');
    expect(source).toContain('buildChatAgentRegistry(');
    expect(source).not.toContain('createClaudeChatAgent');
    expect(source).not.toContain('createCodexChatAgent');
    expect(source).not.toContain('createCursorChatAgent');
    expect(source).not.toContain('createAgyChatAgent');
  });

  it('chat-agent-registry-builder.ts always registers claude and gates codex/cursor/agy behind BDBOARD_CHAT_AGENTS opt-in', () => {
    const builderPath = path.join(CHAT_INFRA_DIR, 'chat-agent-registry-builder.ts');
    const source = readFileSync(builderPath, 'utf8');

    const factoryIds = [
      ...new Set([...source.matchAll(/create\w+ChatAgent/g)].map((match) => match[0])),
    ].sort();
    expect(factoryIds).toEqual(['createAgyChatAgent', 'createClaudeChatAgent', 'createCodexChatAgent', 'createCursorChatAgent']);

    const registerCalls = [...source.matchAll(/registry\.register\(/g)];
    expect(registerCalls).toHaveLength(4);
    const claudeIndex = source.indexOf('createClaudeChatAgent');
    // Use the *last* occurrence for codex/cursor: the import line mentions the
    // identifier too (whether it's a named or namespace import), so indexOf would
    // find that instead of the actual registration call site we care about
    // ordering against.
    const codexCallIndex = source.lastIndexOf('createCodexChatAgent');
    const cursorCallIndex = source.lastIndexOf('createCursorChatAgent');
    const agyCallIndex = source.lastIndexOf('createAgyChatAgent');
    expect(claudeIndex).toBeGreaterThan(-1);
    expect(codexCallIndex).toBeGreaterThan(-1);
    expect(cursorCallIndex).toBeGreaterThan(-1);
    expect(agyCallIndex).toBeGreaterThan(-1);
    const optInGateIndex = source.indexOf('BDBOARD_CHAT_AGENTS');
    expect(optInGateIndex).toBeGreaterThan(-1);
    expect(optInGateIndex).toBeLessThan(codexCallIndex);
    expect(optInGateIndex).toBeLessThan(cursorCallIndex);
    expect(optInGateIndex).toBeLessThan(agyCallIndex);
  });

  it.each(SPEC_FACTORIES)(
    '$label buildTurn delivers ctx.systemPrompt to the CLI (via stdin or args)',
    ({ buildSpec }) => {
      const spec = buildSpec();
      const ctx: CliTurnContext = {
        systemPrompt: SYSTEM_PROMPT_MARKER,
        mcpServers: [{ name: 'bd', command: '/usr/bin/node', args: ['server.ts'] }],
        toolNames: ['bd_ready'],
        scratchDir: '/tmp/bdboard-scratch',
      };
      const request: ChatTurnRequest = {
        projectRootPath: '/tmp/demo',
        projectName: 'demo',
        message: 'hello',
      };

      const plan = spec.buildTurn(request, ctx);
      const deliveredViaStdin = plan.stdin?.includes(SYSTEM_PROMPT_MARKER) ?? false;
      const deliveredViaArgs = plan.args.some((arg) => arg.includes(SYSTEM_PROMPT_MARKER));
      expect(
        deliveredViaStdin || deliveredViaArgs,
        `${spec.descriptor.id}: buildTurn output must include ctx.systemPrompt in stdin or args`,
      ).toBe(true);

      // resume ターンでも同様に届くこと(MF1: codex は毎ターン stdin 前置のため resume でも要確認)。
      const resumePlan = spec.buildTurn({ ...request, resumeSessionId: 'session-1' }, ctx);
      const resumeDeliveredViaStdin = resumePlan.stdin?.includes(SYSTEM_PROMPT_MARKER) ?? false;
      const resumeDeliveredViaArgs = resumePlan.args.some((arg) => arg.includes(SYSTEM_PROMPT_MARKER));
      expect(
        resumeDeliveredViaStdin || resumeDeliveredViaArgs,
        `${spec.descriptor.id}: resume-turn buildTurn output must include ctx.systemPrompt in stdin or args`,
      ).toBe(true);

      // Opus レビュー N4: ソーススキャン(上の別テスト)に加えて、実際に組み立てられた
      // 引数列にも禁止フラグが混入していないことを直接固定する(将来 spec が引数を
      // 動的生成するようになってもソーススキャンをすり抜けないように)。
      for (const args of [plan.args, resumePlan.args]) {
        for (const token of FORBIDDEN_CHAT_TOKENS) {
          expect(
            args.some((arg) => arg.includes(token)),
            `${spec.descriptor.id}: buildTurn args must not include forbidden flag ${token}`,
          ).toBe(false);
        }
      }
    },
  );

  it.each(SPEC_FACTORIES.filter(({ buildSpec }) => {
    const spec = buildSpec();
    return spec.supportsStreaming === true && spec.buildStreamingTurn !== undefined;
  }))(
    '$label buildStreamingTurn delivers ctx.systemPrompt and has no forbidden flags',
    ({ buildSpec }) => {
      const spec = buildSpec();
      const ctx: CliTurnContext = {
        systemPrompt: SYSTEM_PROMPT_MARKER,
        mcpServers: [{ name: 'bd', command: '/usr/bin/node', args: ['server.ts'] }],
        toolNames: ['bd_ready'],
        scratchDir: '/tmp/bdboard-scratch',
      };
      const request: ChatTurnRequest = {
        projectRootPath: '/tmp/demo',
        projectName: 'demo',
        message: 'hello',
      };

      const plan = spec.buildStreamingTurn!(request, ctx);
      const deliveredViaStdin = plan.stdin?.includes(SYSTEM_PROMPT_MARKER) ?? false;
      const deliveredViaArgs = plan.args.some((arg) => arg.includes(SYSTEM_PROMPT_MARKER));
      expect(deliveredViaStdin || deliveredViaArgs).toBe(true);

      for (const token of FORBIDDEN_CHAT_TOKENS) {
        expect(plan.args.some((arg) => arg.includes(token))).toBe(false);
      }
    },
  );
});
