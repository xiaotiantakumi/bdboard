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

/** サーバー (harness-inject-routes.ts) の 409 の error 文字列。web/ から src/ は import できないので二重定義。 */
const SERVER_PACK_NOT_INJECTABLE = 'pack not injectable';

/**
 * 注入の失敗を文言にする。パックの組み合わせ検査で弾かれた 409 (bdboard-l1m1.1) は
 * 「他セッションが先に変更した」ではなくサーバーが返した理由をそのまま出す。
 * それ以外は書き込み共通の説明 (describeWriteError)。
 */
export function describeHarnessInjectError(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.errorMessage === SERVER_PACK_NOT_INJECTABLE &&
    error.reason !== undefined
  ) {
    return `注入できません: ${error.reason}`;
  }
  return describeWriteError(error, 'ハーネスの注入に失敗しました');
}

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
      options?.onError?.(describeHarnessInjectError(error));
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
