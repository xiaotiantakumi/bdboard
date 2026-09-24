import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChatAgentDto } from '../../api';
import { usePersistedState } from '../../hooks/usePersistedState';
import { UI_STORAGE_KEYS, validateChatModelSelections } from '../../uiPersistedState';
import { hasSelectableModels, resolveDefaultModel } from './agentOptions';

export interface UseChatAgentModelStateParams {
  selectedProjectId: string;
  currentConversationKey: string;
  threadModelIds: Record<string, string>;
  setThreadModelIds: Dispatch<SetStateAction<Record<string, string>>>;
}

export interface UseChatAgentModelStateResult {
  agents: readonly ChatAgentDto[];
  setAgents: Dispatch<SetStateAction<readonly ChatAgentDto[]>>;
  selectedAgentId: string;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  selectedAgent: ChatAgentDto | undefined;
  selectedAgentUnavailable: boolean;
  selectedModelId: string;
  setSelectedModelId: Dispatch<SetStateAction<string>>;
  chatModelSelections: Record<string, Record<string, string>>;
  showModelSelect: boolean;
  effectiveModelId: string;
  handleModelChange: (nextModelId: string) => void;
}

export function useChatAgentModelState({
  selectedProjectId,
  currentConversationKey,
  setThreadModelIds,
}: UseChatAgentModelStateParams): UseChatAgentModelStateResult {
  const [agents, setAgents] = useState<readonly ChatAgentDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [chatModelSelections, setChatModelSelections] = usePersistedState<
    Record<string, Record<string, string>>
  >(UI_STORAGE_KEYS.chatModelSelections, {}, validateChatModelSelections);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedAgentUnavailable = selectedAgent?.availability === 'unavailable';
  const showModelSelect = useMemo(
    () => selectedAgent !== undefined && hasSelectableModels(selectedAgent),
    [selectedAgent],
  );

  /**
   * 描画にも送信にもこの派生値だけを使う。エージェントを切り替えた直後の1フレームは
   * selectedModelId が前のエージェントのモデルIDのままなので、state を直接使うと
   * 「どのオプションにも一致しない select」や「前のエージェントのモデルでの送信」が
   * 一瞬成立してしまう。上の effect は state 側を追随させるだけの役割にする。
   */
  const effectiveModelId = useMemo(() => {
    if (selectedAgent === undefined) return '';
    const models = selectedAgent.models ?? [];
    if (models.some((model) => model.id === selectedModelId)) return selectedModelId;
    return resolveDefaultModel(selectedAgent);
  }, [selectedAgent, selectedModelId]);

  const handleModelChange = useCallback(
    (nextModelId: string) => {
      setSelectedModelId(nextModelId);
      // bdboard-2n8: 直接キャッシュへ書き、in-flight の履歴復元より手動選択を優先する。
      setThreadModelIds((prev) => ({ ...prev, [currentConversationKey]: nextModelId }));
      if (selectedAgentId !== '' && selectedProjectId !== '') {
        setChatModelSelections((prev) => ({
          ...prev,
          [selectedProjectId]: {
            ...(prev[selectedProjectId] ?? {}),
            [selectedAgentId]: nextModelId,
          },
        }));
      }
    },
    [currentConversationKey, selectedAgentId, selectedProjectId, setChatModelSelections, setThreadModelIds],
  );

  return {
    agents,
    setAgents,
    selectedAgentId,
    setSelectedAgentId,
    selectedAgent,
    selectedAgentUnavailable,
    selectedModelId,
    setSelectedModelId,
    chatModelSelections,
    showModelSelect,
    effectiveModelId,
    handleModelChange,
  };
}
