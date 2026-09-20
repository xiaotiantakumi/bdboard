import type { CommandRunner } from '../../../application/ports/command-runner.js';
import type { AiQuotaSource, AiQuotaSourceResult } from '../../../application/ports/ai-quota-source.js';
import { parseAiQuotaOutput } from './parse-output.js';
import type { NodeAiQuotaSourceOptions } from './types.js';

// `ai-quota all` は自動取得対象の agy と codex を順番に probe する。両方の ready + panel
// 時間を合わせると50秒強になり得るため、プロセス終了処理の余裕も含めて広めに取る。
const DEFAULT_TIMEOUT_MS = 70_000;
const DEFAULT_COMMAND = 'ai-quota';

export function createNodeAiQuotaSource(
  commandRunner: CommandRunner,
  options?: NodeAiQuotaSourceOptions,
): AiQuotaSource {
  const command = options?.command ?? DEFAULT_COMMAND;
  const args = options?.args ?? ['all'];
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetch(): Promise<AiQuotaSourceResult> {
      const result = await commandRunner.run(command, args, { timeoutMs });
      const fetchedAt = new Date();

      if (result.exitCode !== 0) {
        // stderr/stdout はCLIや環境によってローカルパス・アカウント情報を含み得るため、
        // APIへ伝播させない。
        throw new Error(`ai-quota exited with code ${result.exitCode}`);
      }

      const providers = parseAiQuotaOutput(result.stdout, fetchedAt);
      if (providers.length === 0) {
        throw new Error('ai-quota returned no provider data');
      }
      return { fetchedAt, providers };
    },
  };
}
