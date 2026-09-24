import type { ChatTurnStatusDto } from '../../api';
import {
  TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS,
  UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS,
} from './turnStatusPolicy';

/**
 * bdboard-96rp: sessionId が未確定な detached 送信の追跡情報のうち、判定に
 * 要る2フィールドだけを受け取る型(streamingKey/fail は実行側の
 * useTurnStatusRecovery.ts が持つ)。
 */
export interface TurnStatusStepDetached {
  sessionId: string | undefined;
  detachedAt: number;
}

export interface TurnStatusStepArgs {
  status: ChatTurnStatusDto;
  detached: TurnStatusStepDetached | undefined;
  /** status.state === 'completed' のとき、この sessionId を既に一度この effect
   * 実行内で回収済みか(bdboard-3tw.156 の重複防止印)。 */
  isRecoveredCompletedSession: boolean;
  /** status.state === 'failed' かつ sessionId 確定のとき、この sessionId を
   * 既にこの effect 実行内で ACK 済みか(bdboard-3tw.156 の重複防止印)。 */
  isDrainedFailedSession: boolean;
  /** bdboard-96rp: sessionId 未確定の tracked send が、自身の sessionId 無し
   * failed と時刻的に一致しない状態が何回連続したか。 */
  unmatchedSessionlessFailedStreak: number;
}

export type TurnStatusStep =
  | { kind: 'done'; nextUnmatchedSessionlessFailedStreak: number }
  | {
      kind: 'fail-detached';
      /** 定義されていれば、fail 前にこの sessionId を ACK する
       * (bdboard-3tw.165)。sessionId 無しの failed には ACK 経路が無いため
       * undefined になりうる。ACK 自体はこの関数では行わない(実行側の責務)。 */
      ackSessionId: string | undefined;
      nextUnmatchedSessionlessFailedStreak: number;
    }
  | { kind: 'poll-later'; delayMs: number; nextUnmatchedSessionlessFailedStreak: number }
  | { kind: 'ack-and-recheck'; sessionId: string; nextUnmatchedSessionlessFailedStreak: number }
  | {
      kind: 'hydrate';
      sessionId: string;
      /** bdboard-v3ag (W1): 回収したこの completed が、今 detachedSendsRef が
       * 追っている送信自身の結末とみなせるか。 */
      detachedMatchesThisRecovery: boolean;
      nextUnmatchedSessionlessFailedStreak: number;
    };

const POLL_AGAIN_DELAY_MS = 1_000;

/**
 * bdboard-sso1.83 第12段: ChatPanel.tsx の turn-status 回収 effect(旧 E8)から、
 * 「fetchChatTurnStatus の応答を見て次に何をするか」の決定だけを抜き出した
 * 純粋関数。副作用(ACK/hydrate の fetch・setState・ref の読み書き)は一切行わず、
 * 呼び出し側の chat/useTurnStatusRecovery.ts がこの結果に従って実行する。
 * 分岐と挙動は旧 E8 の本体(bdboard-3tw.164/165/166、bdboard-96rp、bdboard-v3ag、
 * bdboard-qfps)から1つも変えていない。
 */
export function decideTurnStatusStep(args: TurnStatusStepArgs): TurnStatusStep {
  const { status, detached, isRecoveredCompletedSession, isDrainedFailedSession } = args;

  if (status.state === 'idle') {
    // 単一ロック下ではプロジェクトにつき同時に走るターンは高々1つ。idle に
    // 落ちたのは「今追っている detached 送信が completed/failed を残さず
    // settle した」ことを意味するので、sessionId の突き合わせは不要。
    if (detached === undefined) {
      return { kind: 'done', nextUnmatchedSessionlessFailedStreak: 0 };
    }
    return { kind: 'fail-detached', ackSessionId: undefined, nextUnmatchedSessionlessFailedStreak: 0 };
  }

  if (status.state === 'failed') {
    // bdboard-3tw.165: completed と同じく、追っている detached と sessionId が
    // 一致する場合だけ解決する。sessionId 未確定の追跡は、96rp のクロックスキュー
    // 許容幅の中で時刻も突き合わせる。
    const matchesTrackedSend =
      detached !== undefined &&
      (detached.sessionId !== undefined
        ? detached.sessionId === status.sessionId
        : status.sessionId === undefined &&
          Date.parse(status.failedAt) >= detached.detachedAt - TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS);
    if (matchesTrackedSend) {
      return {
        kind: 'fail-detached',
        ackSessionId: status.sessionId,
        nextUnmatchedSessionlessFailedStreak: 0,
      };
    }
    if (status.sessionId === undefined) {
      // bdboard-96rp (round 2): sessionId 未確定の tracked send を追っていて、
      // 時刻突き合わせが一致し続けない場合は GIVEUP_POLLS 回で諦めて自分自身の
      // 失敗として受け入れる(でないと ACK 経路の無いこの手の failed に対して
      // 無期限にブロックし得る)。
      const maybeOwnDelayedFailure = detached !== undefined && detached.sessionId === undefined;
      if (!maybeOwnDelayedFailure) {
        return {
          kind: 'poll-later',
          delayMs: POLL_AGAIN_DELAY_MS,
          nextUnmatchedSessionlessFailedStreak: 0,
        };
      }
      const nextStreak = args.unmatchedSessionlessFailedStreak + 1;
      if (nextStreak >= UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS) {
        return {
          kind: 'fail-detached',
          ackSessionId: undefined,
          nextUnmatchedSessionlessFailedStreak: 0,
        };
      }
      // bdboard-v3ag (blocker B1): 無条件 return だと次のトリガーが無い限り
      // 二度と聞き直さない。'processing' と同じ間隔で粘り強くポーリングする。
      return {
        kind: 'poll-later',
        delayMs: POLL_AGAIN_DELAY_MS,
        nextUnmatchedSessionlessFailedStreak: nextStreak,
      };
    }
    if (isDrainedFailedSession) {
      return { kind: 'poll-later', delayMs: POLL_AGAIN_DELAY_MS, nextUnmatchedSessionlessFailedStreak: 0 };
    }
    // 追っている送信とは無関係。後ろに隠れているかもしれない completed/failed
    // を取りこぼさないよう ACK して聞き直す(bdboard-3tw.165)。
    return { kind: 'ack-and-recheck', sessionId: status.sessionId, nextUnmatchedSessionlessFailedStreak: 0 };
  }

  if (status.state === 'processing') {
    return { kind: 'poll-later', delayMs: POLL_AGAIN_DELAY_MS, nextUnmatchedSessionlessFailedStreak: 0 };
  }

  // status.state === 'completed'
  if (isRecoveredCompletedSession) {
    // bdboard-v3ag (blocker B1): completed 側も同じ理由で無条件 return にしない。
    return { kind: 'poll-later', delayMs: POLL_AGAIN_DELAY_MS, nextUnmatchedSessionlessFailedStreak: 0 };
  }
  // bdboard-v3ag (W1、round 2 レビューでリバート済み): sessionId 未確定の
  // detached は completed 側では時刻突き合わせをしない。ハイドレーション完了後
  // の ACK+drain で毎回一致確認されるため、無条件マッチの方が安全側に倒れる。
  const detachedMatchesThisRecovery =
    detached !== undefined && (detached.sessionId === undefined || detached.sessionId === status.sessionId);
  return {
    kind: 'hydrate',
    sessionId: status.sessionId,
    detachedMatchesThisRecovery,
    nextUnmatchedSessionlessFailedStreak: 0,
  };
}
