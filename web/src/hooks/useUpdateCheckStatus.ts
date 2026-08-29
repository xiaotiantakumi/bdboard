import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchUpdateCheck, type UpdateCheckDto } from '../api';

const UPDATE_CHECK_STORAGE_KEY = 'bdboard.updateCheck.v1';
const UPDATE_CHECK_QUERY_KEY = ['update-check'] as const;
const UPDATE_CHECK_STALE_TIME_MS = 60 * 60 * 1000;

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

function readStorageItem(key: string): string | null {
  try {
    const storage = getStorage();
    if (storage === null) {
      return null;
    }
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    const storage = getStorage();
    if (storage === null) {
      return;
    }
    storage.setItem(key, value);
  } catch {
    // localStorage unavailable (private browsing quota, etc.)
  }
}

function isUpdateCheckDto(value: unknown): value is UpdateCheckDto {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.state === 'up-to-date' || obj.state === 'unknown') {
    return typeof obj.currentVersion === 'string';
  }
  if (obj.state === 'update-available') {
    return (
      typeof obj.currentVersion === 'string' &&
      typeof obj.latestVersion === 'string' &&
      typeof obj.releaseUrl === 'string'
    );
  }
  return false;
}

function readStoredUpdateCheck(): UpdateCheckDto | undefined {
  const raw = readStorageItem(UPDATE_CHECK_STORAGE_KEY);
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUpdateCheckDto(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredUpdateCheck(data: UpdateCheckDto): void {
  writeStorageItem(UPDATE_CHECK_STORAGE_KEY, JSON.stringify(data));
}

/** ヘルプを開いたときだけ fetch し、結果を react-query キャッシュと localStorage に残す。 */
export function useUpdateCheckQuery() {
  const query = useQuery({
    queryKey: UPDATE_CHECK_QUERY_KEY,
    queryFn: fetchUpdateCheck,
    staleTime: UPDATE_CHECK_STALE_TIME_MS,
    retry: false,
  });

  useEffect(() => {
    if (query.data !== undefined) {
      writeStoredUpdateCheck(query.data);
    }
  }, [query.data]);

  return query;
}

/**
 * ヘッダーなどヘルプ外から、過去に取得した更新チェック結果だけを読む。
 * enabled: false のため新規 fetch は発生しない。
 *
 * `initialData` オプションは使わない — TData|undefined を返す関数を渡すと
 * TanStack Query v5 の型推論結果が discriminated union として narrowing
 * できなくなる問題があるため (実測)。代わりに、react-query 側にまだ
 * データが無いとき (= このブラウザで一度も useUpdateCheckQuery が発火して
 * いないとき) だけ localStorage の値へフォールバックする。
 */
export function useCachedUpdateCheck(): UpdateCheckDto | undefined {
  const query = useQuery({
    queryKey: UPDATE_CHECK_QUERY_KEY,
    queryFn: fetchUpdateCheck,
    enabled: false,
    staleTime: UPDATE_CHECK_STALE_TIME_MS,
  });

  return query.data ?? readStoredUpdateCheck();
}
