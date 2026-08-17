import { compareStrings } from '../../domain/compare.js';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RunRequest } from '../ports/agent-runner.js';

export interface AgentRunnerRegistry {
  register(runner: AgentRunner): void;
  /** Returns runners that can handle the request, in priority order. Experimental runners are last. */
  resolve(request: RunRequest): readonly AgentRunner[];
  list(): readonly AgentRunner[];
}

function sortRunners(runners: readonly AgentRunner[]): AgentRunner[] {
  const stable = runners.filter((r) => !r.experimental);
  const experimental = runners.filter((r) => r.experimental);

  // Prefer stable official paths first; experimental adapters that depend on
  // private APIs are fallbacks only. Trying experimental paths first would
  // normalize fragile failures and hide whether official paths are healthy.
  stable.sort((a, b) => compareStrings(a.id, b.id));
  experimental.sort((a, b) => compareStrings(a.id, b.id));

  return [...stable, ...experimental];
}

export function createAgentRunnerRegistry(): AgentRunnerRegistry {
  const runners = new Map<string, AgentRunner>();

  return {
    register(runner: AgentRunner): void {
      runners.set(runner.id, runner);
    },

    resolve(request: RunRequest): readonly AgentRunner[] {
      const matching = [...runners.values()].filter((r) => r.supports(request));
      return sortRunners(matching);
    },

    list(): readonly AgentRunner[] {
      return sortRunners([...runners.values()]);
    },
  };
}
