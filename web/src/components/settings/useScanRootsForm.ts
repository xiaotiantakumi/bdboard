// bdboard-sso1.10 (PR-F): SettingsPanel.tsx の「スキャンルート・除外パス」フォーム
// (EffectiveScanRootsSection / ScanRootsSection / ExcludePathsSection と footer の保存ボタンが
// 読む state)の query + state + mutation + effect を、挙動を変えずにこのカスタムフックへ
// 抽出しただけのファイル。呼び出し順序・依存配列・queryKey・onSuccess/onError の中身は
// 移動前から変えていない。addPath/removePath/addExcludePath/removeExcludePath はフックでは
// なく通常の関数なので、フック呼び出し順のルールに関わらずそのまま移動している。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  fetchScanRootsConfig,
  postRefresh,
  putScanRootsConfig,
  type ScanRootsConfigDto,
} from '../../api';
import { useSaveFeedback } from '../../hooks/useSaveFeedback';
import { isAbsolutePath } from './validators';
import { describeScanRootWriteError } from './errors';

export interface ScanRootsForm {
  query: UseQueryResult<ScanRootsConfigDto>;
  scanRoots: string[];
  excludePaths: string[];
  newPath: string;
  newExcludePath: string;
  pathHint: string;
  excludePathHint: string;
  isDirty: boolean;
  isSaving: boolean;
  onNewPathChange: (value: string) => void;
  onNewExcludePathChange: (value: string) => void;
  onAddPath: () => void;
  onRemovePath: (path: string) => void;
  onAddExcludePath: () => void;
  onRemoveExcludePath: (path: string) => void;
  onSubmit: () => void;
  feedback: { message: ReactNode; isError: boolean };
}

export function useScanRootsForm(): ScanRootsForm {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['scan-roots-config'], queryFn: fetchScanRootsConfig });
  const [scanRoots, setScanRoots] = useState<string[]>([]);
  const [excludePaths, setExcludePaths] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newExcludePath, setNewExcludePath] = useState('');
  const scanRootsFeedback = useSaveFeedback();
  const [pathHint, setPathHint] = useState('');
  const [excludePathHint, setExcludePathHint] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setScanRoots(query.data.scanRoots);
      setExcludePaths(query.data.excludePaths);
      setVersion(query.data.version);
    }
  }, [dirty, query.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      putScanRootsConfig({
        scanRoots,
        excludePaths,
        version,
      }),
    onSuccess: async (data) => {
      // S3: the PUT response carries the version the server actually persisted this write as —
      // use it directly instead of waiting on the subsequent GET (invalidateQueries still runs,
      // to keep scanRoots/excludePaths in sync with the server's canonical trimmed/normalized
      // values, but the version itself doesn't need to round-trip through a refetch).
      setVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
      setDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving scan roots', error);
      }
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      scanRootsFeedback.showSuccess('設定を保存しました');
    },
    onError: (error) => {
      scanRootsFeedback.showError(describeScanRootWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
      }
    },
  });

  function addPath() {
    const path = newPath.trim();
    if (path.length === 0 || !isAbsolutePath(path)) {
      setPathHint(
        '絶対パスを入力してください (例: /Users/you/projects, C:\\Users\\you\\projects)',
      );
      return;
    }
    if (scanRoots.includes(path)) {
      setPathHint('既に追加されています');
      return;
    }
    setScanRoots((roots) => [...roots, path]);
    setDirty(true);
    setNewPath('');
    setPathHint('');
  }

  function removePath(path: string) {
    setScanRoots((roots) => roots.filter((root) => root !== path));
    setDirty(true);
  }

  function addExcludePath() {
    // Discovery matches `excluded` itself or the `excluded + '/'` prefix, so a trailing
    // separator would silently disable the exclusion — strip it before validating/saving.
    const path = newExcludePath.trim().replace(/[\\/]+$/, '');
    if (path.length === 0 || !isAbsolutePath(path)) {
      setExcludePathHint(
        '絶対パスを入力してください (例: /Users/you/projects, C:/Users/you/projects)',
      );
      return;
    }
    if (excludePaths.includes(path)) {
      setExcludePathHint('既に追加されています');
      return;
    }
    setExcludePaths((paths) => [...paths, path]);
    setDirty(true);
    setNewExcludePath('');
    setExcludePathHint('');
  }

  function removeExcludePath(path: string) {
    setExcludePaths((paths) => paths.filter((currentPath) => currentPath !== path));
    setDirty(true);
  }

  return {
    query,
    scanRoots,
    excludePaths,
    newPath,
    newExcludePath,
    pathHint,
    excludePathHint,
    isDirty: dirty,
    isSaving: saveMutation.isPending,
    onNewPathChange: setNewPath,
    onNewExcludePathChange: setNewExcludePath,
    onAddPath: addPath,
    onRemovePath: removePath,
    onAddExcludePath: addExcludePath,
    onRemoveExcludePath: removeExcludePath,
    onSubmit: () => saveMutation.mutate(),
    feedback: { message: scanRootsFeedback.message, isError: scanRootsFeedback.isError },
  };
}
