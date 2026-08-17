import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  postProjectHarnessInject,
  type ProjectHarnessPackStatusDto,
} from '../api';
import {
  buildHarnessInjectSuccessMessage,
} from '../harnessDisplay';
import { describeWriteError } from '../writeAccessMessage';

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

export function useHarnessFeedback() {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const showFeedback = useCallback((nextMessage: string) => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setMessage(nextMessage);
    timeoutRef.current = setTimeout(() => {
      setMessage('');
      timeoutRef.current = null;
    }, FEEDBACK_MS);
  }, []);

  return { message, showFeedback };
}
