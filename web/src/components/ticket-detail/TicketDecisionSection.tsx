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
           * bdboard-q1k9: ambiguousGateIds が返ってきた場合、respond() は何も
           * resolve していない(human ラベルも外れていない)。closed は常に
           * false のまま同じなので、下の通常分岐(「確認待ちから外れ、次の更新で
           * 通常のレーンに戻ります」)をそのまま出すと実際には何も変わっていない
           * のに解決したかのように誤読させる(bdboard-v78e)。この分岐を優先し、
           * 個別の gate へ回答するよう促す。kind/closed との整合性
           * (kind==='ticket' かつ closed===false のときだけ設定される、配列は
           * 非空)は web/src/api/decisions.ts の mapTicketDecisionOutcome 側で強制済みなので、
           * ここでは ambiguousGateIds の有無だけを見ればよい。
           * bdboard-cine: ambiguousGateIds が付く理由は2つある — (1) 独立した
           * human gate が2件以上ブロックしている(bdboard-q1k9)、(2) gate が1件
           * 以上あり、かつこのチケット自身も standalone な decision_question を
           * 持っている(bdboard-cine)。RespondOutcome はどちらの理由かを区別して
           * 返さないため、文言はどちらでも正しく読める理由不問の表現にしている。
           * bdboard-rftd: (2) の場合、respond() はこの回答を T 自身の質問への
           * 最終回答とみなし、metadata.decision_question を消す(質問文自体は
           * この回答コメントに残るので履歴は失われない)。そのため以下の gate に
           * 個別に回答すれば、mw8y の gate 側respond()の掃除(clearHumanLabelOnUnblockedTickets)
           * が正しくこのチケットの human ラベルを外せる — このチケットへの
           * もう一度の回答は不要になったため、その案内(PR #729 の暫定文言)は
           * この PR で削除した。
           */}
          {submittedDecision.outcome.ambiguousGateIds !== undefined ? (
            <>
              <p className="detail-help">
                このチケットには、個別に回答が必要な human gate が残っています。回答はこのチケットへのコメントとして記録しましたが、gate の解決と確認待ちの解除は行っていません。このチケットは確認待ちのまま残ります。下の gate を開いて個別に回答してください。
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
          {submittedDecision.outcome.clearedHumanLabelTicketIds !== undefined && (
            <>
              <p className="detail-help">
                他に {submittedDecision.outcome.clearedHumanLabelTicketIds.length} 件のチケットの確認待ちも解除しました:
              </p>
              <ul className="detail-list">
                {submittedDecision.outcome.clearedHumanLabelTicketIds.map((ticketId) => (
                  <li key={ticketId}>
                    <button
                      type="button"
                      className="ticket-id-link"
                      onClick={() => onOpenTicket(ticketId)}
                    >
                      {ticketId}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
