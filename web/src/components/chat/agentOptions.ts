// bdboard-sso1.2: ChatPanel.tsx から純粋ヘルパーを移動しただけのファイル。
// 挙動は一切変えていない。
import type { ChatAgentDto } from '../../api';

export function hasSelectableModels(agent: ChatAgentDto): boolean {
  return (agent.models?.length ?? 0) >= 2;
}

export function formatAgentOptionLabel(agent: ChatAgentDto): string {
  let label = agent.label;
  // モデルを選べるエージェントでは、隣のモデルセレクトが現在値を持っている。
  // ここに descriptor 既定(例: sonnet)を出すと、Opus を選んでいるのに
  // "Claude Code (sonnet)" と表示され、2つのコントロールが矛盾する。
  if (
    !hasSelectableModels(agent) &&
    agent.model !== undefined &&
    agent.model !== ''
  ) {
    label += ` (${agent.model})`;
  }
  if (agent.experimental) {
    label += ' [experimental]';
  }
  if (agent.capability !== 'bd-only') {
    label += ` [${agent.capability}]`;
  }
  label += agent.supportsImages ? ' [画像対応]' : ' [画像非対応]';
  if (agent.availability === 'unavailable') {
    label += '（利用不可）';
  } else if (agent.availability === 'unknown') {
    label += '（認証未確認）';
  }
  return label;
}

export function resolveDefaultModel(agent: ChatAgentDto): string {
  const models = agent.models ?? [];
  if (
    agent.model !== undefined &&
    models.some((entry) => entry.id === agent.model)
  ) {
    return agent.model;
  }
  return models[0]?.id ?? '';
}
