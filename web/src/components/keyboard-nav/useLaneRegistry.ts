// bdboard-sso1.39: BoardKeyboardNavProvider.tsx から、レーンごとのカード ID
// 登録(registerLane/unregisterLane)とその参照ヘルパーを move-only で切り出した
// フック。挙動は元の実装と同一（PR 本文の effect 不変条件の表を参照）。
import { useCallback, useRef, useState, type RefObject } from 'react';
import { type Lane } from '../../api';
import { findLaneForCardIn, getNonEmptyLanesFor } from './laneLookup';

export interface LaneRegistry {
  readonly laneCardsRef: RefObject<Map<Lane, readonly string[]>>;
  readonly laneRegistryVersion: number;
  readonly registerLane: (lane: Lane, ids: readonly string[]) => void;
  readonly unregisterLane: (lane: Lane) => void;
  readonly getNonEmptyLanes: () => Lane[];
  readonly findLaneForCard: (cardId: string) => Lane | null;
  readonly getDefaultFocusedCardId: () => string | null;
}

export function useLaneRegistry(): LaneRegistry {
  const laneCardsRef = useRef<Map<Lane, readonly string[]>>(new Map());
  const [laneRegistryVersion, bumpLaneRegistry] = useState(0);

  const registerLane = useCallback((lane: Lane, ids: readonly string[]) => {
    laneCardsRef.current.set(lane, ids);
    bumpLaneRegistry((version) => version + 1);
  }, []);

  const unregisterLane = useCallback((lane: Lane) => {
    laneCardsRef.current.delete(lane);
    // レーン内容が変わるたびに unregister→register が走るため、ここで記憶を消すと
    // 記憶がほぼ毎回失われる。古い記憶は moveAcrossLanes の存在チェックで無効化する。
    bumpLaneRegistry((version) => version + 1);
  }, []);

  const getNonEmptyLanes = useCallback((): Lane[] => {
    return getNonEmptyLanesFor(laneCardsRef.current);
  }, []);

  const findLaneForCard = useCallback((cardId: string): Lane | null => {
    return findLaneForCardIn(laneCardsRef.current, cardId);
  }, []);

  const getDefaultFocusedCardId = useCallback((): string | null => {
    const lanes = getNonEmptyLanes();
    if (lanes.length === 0) {
      return null;
    }
    const firstLane = lanes[0]!;
    const ids = laneCardsRef.current.get(firstLane);
    return ids !== undefined && ids.length > 0 ? ids[0]! : null;
  }, [getNonEmptyLanes]);

  return {
    laneCardsRef,
    laneRegistryVersion,
    registerLane,
    unregisterLane,
    getNonEmptyLanes,
    findLaneForCard,
    getDefaultFocusedCardId,
  };
}
