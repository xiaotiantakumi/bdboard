import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { fetchChatAgents, type ChatAgentDto } from '../../api';
import { resolveDefaultModel } from './agentOptions';

export function useAgentListAndModelRestore(params: {
  selectedAgent: ChatAgentDto | undefined;
  selectedProjectId: string;
  currentConversationKey: string;
  threadModelIds: Record<string, string>;
  chatModelSelections: Record<string, Record<string, string>>;
  setAgents: Dispatch<SetStateAction<readonly ChatAgentDto[]>>;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  setSelectedModelId: Dispatch<SetStateAction<string>>;
}): void {
  const {
    selectedAgent,
    selectedProjectId,
    currentConversationKey,
    threadModelIds,
    chatModelSelections,
    setAgents,
    setSelectedAgentId,
    setSelectedModelId,
  } = params;

  useEffect(() => {
    let cancelled = false;
    void fetchChatAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        if (list.length > 0) {
          setSelectedAgentId((current) => (current === '' ? list[0]!.id : current));
        }
      })
      .catch(() => {
        // エージェント一覧が取れなくてもチャット自体は従来どおり使える
      });
    return () => {
      cancelled = true;
    };
  }, [setAgents, setSelectedAgentId]);

  useEffect(() => {
    if (selectedAgent === undefined) return;
    // bdboard-2n8 / ru4d: 会話キーのモデル選択を優先し、実在しないモデルIDは採用しない。
    const cached = threadModelIds[currentConversationKey];
    if (cached !== undefined && (selectedAgent.models ?? []).some((model) => model.id === cached)) {
      setSelectedModelId(cached);
      return;
    }
    const persisted = chatModelSelections[selectedProjectId]?.[selectedAgent.id];
    if (
      persisted !== undefined &&
      (selectedAgent.models ?? []).some((model) => model.id === persisted)
    ) {
      setSelectedModelId(persisted);
      return;
    }
    setSelectedModelId(resolveDefaultModel(selectedAgent));
  }, [
    selectedAgent,
    selectedProjectId,
    currentConversationKey,
    threadModelIds,
    chatModelSelections,
    setSelectedModelId,
  ]);
}
