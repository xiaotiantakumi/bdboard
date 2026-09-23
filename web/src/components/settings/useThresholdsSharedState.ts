// bdboard-59if: BoardThresholdsSection と WipLimitsSection は、サーバー側では同じ設定
// ドキュメント (board-thresholds-config) = 同じ version を共有している。楽観ロックの
// 書き戻しは「どちらのフォームにも未保存の編集が無いとき」に限る必要がある
// (bdboard-chp)。この2セクションぶんの query/version/dirty state と、その版数ガード
// effect を1つのフックへ集約し、SettingsPanel からは1回の呼び出しで両方の
// useBoardThresholdsForm / useWipLimitsForm に渡せる形にする。
//
// queryKey ['board-thresholds-config'] とその queryFn は App.tsx の
// useBoardThresholdsData (bdboard-62p4) と完全に同じ文字列なので、TanStack Query の
// キャッシュを引き続き共有する。ここでは retry 等の追加オプションを付けない
// (元の SettingsPanel.tsx の thresholdsQuery もオプションなしだった)。
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchBoardThresholdsConfig, type BoardThresholdsConfigDto } from '../../api';

export interface ThresholdsSharedState {
  query: UseQueryResult<BoardThresholdsConfigDto>;
  version: string;
  thresholdsDirty: boolean;
  setThresholdsDirty: (dirty: boolean) => void;
  wipDirty: boolean;
  setWipDirty: (dirty: boolean) => void;
  onVersionChange: (version: string) => void;
}

export function useThresholdsSharedState(): ThresholdsSharedState {
  const query = useQuery({
    queryKey: ['board-thresholds-config'],
    queryFn: fetchBoardThresholdsConfig,
  });
  const [version, setVersion] = useState('');
  const [thresholdsDirty, setThresholdsDirty] = useState(false);
  const [wipDirty, setWipDirty] = useState(false);

  // 以前は BoardThresholdsSection と WipLimitsSection それぞれの effect が自分の
  // dirty フラグだけを見て version を更新していた。片方だけを編集していると、
  // もう片方の effect が refetch のたびに version を最新へ差し替えてしまい、保存時に
  // 409 が出ず他セッションの変更を黙って上書きしていた (bdboard-chp)。楽観ロックが
  // 効いていたのは「両方とも編集中」のときだけだった。
  //
  // 逆に、どちらも未編集なら素直に進める必要がある。ここまで止めると、開いた
  // ままのタブから保存すると必ず 409 になる。
  useEffect(() => {
    if (query.data !== undefined && !thresholdsDirty && !wipDirty) {
      setVersion(query.data.version);
    }
  }, [thresholdsDirty, wipDirty, query.data]);

  return {
    query,
    version,
    thresholdsDirty,
    setThresholdsDirty,
    wipDirty,
    setWipDirty,
    onVersionChange: setVersion,
  };
}
