// bdboard-sso1.5 (PR-L): TicketDetailPanel.tsx の「ユーザー確認待ち」(質問と
// 回答欄) と「送信した回答」の2ブロックを移動しただけの表示専用コンポーネント。
// state・mutation は useTicketDecisionAnswer (親で呼び出し) に残し、値と
// ハンドラを props で受け取る。JSX・className・aria属性・文言・DOM構造は
// 移動前から変えていない。
import type { PendingDecisionDto } from '../../api';
import { describeWriteError } from '../../writeAccessMessage';
import type { SubmittedDecision } from './types';

export interface TicketDecisionSectionProps {
  pendingDecision: PendingDecisionDto | undefined;
  selectedChoice: string | undefined;
  onSelectChoice: (choice: string) => void;
  freeformText: string;
  onFreeformTextChange: (value: string) => void;
  canSubmitDecision: boolean;
  decisionMutation: {
    isPending: boolean;
    error: unknown;
    mutate: () => void;
  };
  submittedDecision: SubmittedDecision | null;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketDecisionSection({
  pendingDecision,
  selectedChoice,
  onSelectChoice,
  freeformText,
  onFreeformTextChange,
  canSubmitDecision,
  decisionMutation,
  submittedDecision,
  onOpenTicket,
}: TicketDecisionSectionProps) {
  return (
    <>
      {pendingDecision !== undefined && (
        <div className="detail-section">
          <h3>ユーザー確認待ち</h3>
          {pendingDecision.question !== undefined && (
            <p className="detail-pre">{pendingDecision.question}</p>
          )}
          {pendingDecision.options !== undefined &&
            pendingDecision.options.length > 0 && (
              <div className="decision-options">
                {pendingDecision.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`toggle-btn decision-option-btn${
                      selectedChoice === option.value ? ' active' : ''
                    }`}
                    onClick={() => onSelectChoice(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          <label className="decision-freeform-label" htmlFor="decision-freeform">
            自由記入
          </label>
          <textarea
            id="decision-freeform"
            className="decision-freeform-input"
            value={freeformText}
            onChange={(event) => onFreeformTextChange(event.target.value)}
            rows={4}
          />
          {/*
           * pendingDecision.kind はキャッシュ由来で 'ticket' に倒れうる。
           * 'gate' と判定されたときだけ予告を出す片側運用。'ticket' 側には出さない。
           */}
          {pendingDecision.kind === 'gate' && (
            <p className="detail-help">
              これは質問専用のゲートです。回答するとゲートはクローズされ、ブロックされていたチケットが着手可能になります。
            </p>
          )}
          <button
            type="button"
            className="btn"
            disabled={!canSubmitDecision || decisionMutation.isPending}
            onClick={() => decisionMutation.mutate()}
          >
            {decisionMutation.isPending ? '送信中…' : '回答を送信'}
          </button>
          {decisionMutation.error !== null && (
            <p className="error-message">
              {describeWriteError(
                decisionMutation.error,
                '回答の送信に失敗しました',
              )}
            </p>
          )}
        </div>
      )}
      {submittedDecision !== null &&
        (pendingDecision === undefined ||
          pendingDecision.id === submittedDecision.decisionId) && (
        <div className="detail-section">
          <h3>送信した回答</h3>
          {submittedDecision.choiceLabel !== undefined && (
            <p className="detail-pre">{submittedDecision.choiceLabel}</p>
          )}
          {submittedDecision.freeform !== undefined && (
            <p className="detail-pre">{submittedDecision.freeform}</p>
          )}
          <p className="detail-help">回答を送信しました</p>
          {/*
           * bdboard-q1k9: ambiguousGateIds が返ってきた場合、このチケットは
           * 2件以上の独立した human gate にブロックされていて、どの質問への
           * 回答か特定できず respond() は何も resolve していない(human ラベルも
           * 外れていない)。closed は常に false のまま同じなので、下の通常分岐
           * (「確認待ちから外れ、次の更新で通常のレーンに戻ります」)をそのまま
           * 出すと実際には何も変わっていないのに解決したかのように誤読させる
           * (bdboard-v78e)。この分岐を優先し、個別の gate へ回答するよう促す。
           * kind/closed との整合性(kind==='ticket' かつ closed===false のとき
           * だけ設定される、配列は非空)は web/src/api.ts の
           * mapTicketDecisionOutcome 側で強制済みなので、ここでは
           * ambiguousGateIds の有無だけを見ればよい。
           */}
          {submittedDecision.outcome.ambiguousGateIds !== undefined ? (
            <>
              <p className="detail-help">
                このチケットは複数の質問(gate)に分かれています。どの質問への回答か特定できなかったため、回答はコメントとして記録しましたが、gate の解決と確認待ちの解除は行っていません。このチケットは確認待ちのまま残ります。下の gate を開いて個別に回答してください。
              </p>
              {/*
               * bdboard-v78e レビュー指摘: gate はエピック絞り込みの対象外
               * (parentId を持たない)なので、絞り込み中は isTicketOnBoard(gateId)
               * が false になり TicketIdLink が非クリック化してしまう
               * (「現在のボードに表示されていません」)。ここで列挙する gate ID は
               * ユーザーが自由入力したテキストからの自動リンクではなく respond()
               * のレスポンスに含まれるサーバー由来の確定 ID なので、盤面フィルタの
               * 状態に関わらず常にクリック可能にする(TicketIdLink は使わない)。
               */}
              <ul className="detail-list">
                {submittedDecision.outcome.ambiguousGateIds.map((gateId) => (
                  <li key={gateId}>
                    <button
                      type="button"
                      className="ticket-id-link"
                      onClick={() => onOpenTicket(gateId)}
                    >
                      {gateId}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="detail-help">
              {submittedDecision.outcome.kind === 'unknown'
                ? '種別(ゲート/作業チケット)を判定できませんでした。回答はコメントとして記録しましたが、確認待ちのまま残っています。しばらくしてからもう一度送信してください。'
                : submittedDecision.outcome.closed
                  ? '確認用のゲートを解決しました。ブロックされていたチケットが次の更新で着手可能になります。'
                  : 'このチケットはクローズしていません。確認待ちから外れ、次の更新で通常のレーンに戻ります。'}
            </p>
          )}
        </div>
      )}
    </>
  );
}
