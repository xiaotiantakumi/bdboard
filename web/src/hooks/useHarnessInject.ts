import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
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
    onError: (error, vars) => {
      // 409 (pack not injectable など) は「手元の一覧が古い」ことを示す。取り直さないと、
      // 古い GET の結果で押せるボタンが残り、同じ 409 を繰り返してしまう (bdboard-l1m1.14)。
      // 失敗の表示を待たせないよう await しない (bdboard-ty72 と同じく、表示は即時)。
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: ['project-harness', vars.projectId],
        });
      }
      // 409 (pack not injectable) の文言も describeWriteError が持つ。
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
