import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  postProjectHarnessInject,
  type ProjectHarnessPackStatusDto,
} from '../api';
import {
  buildHarnessInjectSuccessMessage,
} from '../harnessDisplay';
import { describeWriteError } from '../writeAccessMessage';
import { useAutoClearedValue } from './useAutoClearedValue';

const FEEDBACK_MS = 4000;

export interface UseHarnessInjectOptions {
  readonly onSuccess?: (message: string) => void;
  readonly onError?: (message: string) => void;
}

export function useHarnessInject(options?: UseHarnessInjectOptions) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: {
      projectId: string;
      pack: ProjectHarnessPackStatusDto;
    }) => {
      const status = await postProjectHarnessInject(vars.projectId, vars.pack.name);
      return { ...vars, status };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: ['project-harness', result.projectId],
      });
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      options?.onSuccess?.(
        buildHarnessInjectSuccessMessage(result.pack.name, result.pack),
      );
    },
    onError: (error) => {
      options?.onError?.(describeWriteError(error, 'ハーネスの注入に失敗しました'));
    },
  });
}

/**
 * 注入結果の表示。
 *
 * bdboard-ty72: showFeedback は useHarnessInject の onSuccess から呼ばれ、そこは
 * invalidateQueries を2本 await した**後**なので、アンマウント後に走りうる。
 * タイマーIDを ref に持ってアンマウント時に消すだけでは足りない (クリーンアップの
 * 後に新しいタイマーを仕掛けてしまう) ので、useAutoClearedValue に任せる。
 */
export function useHarnessFeedback() {
  const { value: message, show: showFeedback } = useAutoClearedValue(
    '',
    FEEDBACK_MS,
  );
  return { message, showFeedback };
}
