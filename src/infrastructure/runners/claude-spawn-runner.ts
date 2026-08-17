import type { AgentRunner } from '../../application/ports/agent-runner.js';
import { createClaudeRunner, type ClaudeRunnerOptions } from './claude-runner.js';

export function createClaudeSpawnRunner(
  options?: ClaudeRunnerOptions,
): AgentRunner {
  return createClaudeRunner('claude-spawn', 'spawn', options);
}
