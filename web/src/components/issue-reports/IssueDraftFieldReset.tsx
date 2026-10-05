import { useEffect, useRef, useState } from 'react';

export interface IssueDraftFieldResetProps {
  /** 戻す欄の呼び名 (「題名」「本文」)。ボタンの文言と確認の文に使う。 */
  readonly label: string;
  /** 戻すと捨てる内容がある (直した文か、まだ保存していない入力)。true のときだけ、押したあとに確認を挟む。 */
  readonly needsConfirm: boolean;
  /** 保存中・戻している最中 (どのボタンも押せない)。 */
  readonly disabled: boolean;
  readonly onReset: () => void;
}

/**
 * 「直した」印の付いた欄を、自動で組んだ内容へ戻すボタン (bdboard-494n)。空で保存すると戻る (bdboard-pnvj) より前に、
 * '' と「直した」印で保存された欄は、編集欄が初めから空で、保存しても何も送らないため、画面から戻せなかった。
 * このボタンは入力の差分に関係なく、その欄だけを空にした PATCH を送る (親が送る)。捨てる内容があるときは、押したあとに
 * 「捨てて戻す」「戻すのをやめる」を出す (安全側の「戻すのをやめる」へフォーカスを置く)。何も捨てないとき (空の欄) はすぐ戻す。
 */
export function IssueDraftFieldReset({ label, needsConfirm, disabled, onReset }: IssueDraftFieldResetProps) {
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  return (
    <div className="issue-draft-editor-reset">
      <button
        ref={triggerRef}
        type="button"
        className="btn issue-draft-editor-reset-btn"
        disabled={disabled}
        aria-expanded={needsConfirm ? confirming : undefined}
        onClick={() => (needsConfirm ? setConfirming(true) : onReset())}
      >
        {label}を自動の文に戻す
      </button>
      {confirming && needsConfirm && (
        <div className="issue-draft-editor-reset-confirm" role="group" aria-label={`${label}を戻す確認`}>
          <p className="issue-draft-editor-reset-text">今の{label}は捨てて、自動で組んだ内容に戻します。</p>
          <button
            ref={cancelRef}
            type="button"
            className="btn issue-draft-editor-reset-btn"
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              triggerRef.current?.focus();
            }}
          >
            戻すのをやめる
          </button>
          <button
            type="button"
            className="btn btn-danger issue-draft-editor-reset-btn"
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              triggerRef.current?.focus();
              onReset();
            }}
          >
            捨てて戻す
          </button>
        </div>
      )}
    </div>
  );
}
