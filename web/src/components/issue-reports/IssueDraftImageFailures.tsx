import { useEffect, useRef, useState } from 'react';

export interface IssueDraftImageFailureItem {
  /** どの画像か。同じ名前の画像 (貼り付けは image.png ばかり) を見分けるため、位置も入れる (`2 枚目「image.png」`)。 */
  readonly label: string;
  readonly reason: string;
}

export interface IssueDraftImageFailuresProps {
  /** 一覧が新しくなったとき (送り直しの結果) にフォーカスを見出しへ戻すので、内容が変わらないうちは同じ配列を渡す (useMemo)。 */
  readonly failures: readonly IssueDraftImageFailureItem[];
  /** 付かなかった画像を送り直している間。 */
  readonly sending: boolean;
  readonly onRetry: () => void;
  readonly onOpen: () => void;
}

/**
 * 下書きは作れたが、画像が一部付かなかったときの画面 (bdboard-4y8q.6.9)。書く画面の代わりに出す。
 * 下書きは作成済みなので、ここには題名・説明・画像の入力も「送る」も出さない (もう一度送って同じ報告を重ねて作る事故を防ぐ)。
 * 出すのは、付かなかった画像と理由、その画像だけの送り直し、作った下書きを開く操作。
 */
export function IssueDraftImageFailures({ failures, sending, onRetry, onOpen }: IssueDraftImageFailuresProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 一覧が新しくなるたびに増やす数 (bdboard-8zwi)。送り直しても同じ画像が同じ理由で落ちると、alert の文は前と同じで、読み上げ側は
  // 変化がないものとして読まない。alert の要素をこの数で作り直し、結果が出るたびに新しい alert として読ませる。
  // 描画の途中で前回の props と比べる書き方は React の公式の形 (effect で setState すると 1 回余計に描画する)。
  const [announced, setAnnounced] = useState({ failures, round: 0 });
  if (announced.failures !== failures) {
    setAnnounced({ failures, round: announced.round + 1 });
  }

  // 書く画面の「送る」を押した位置のボタンは消えるので、フォーカスを見出しへ移して結果を読み上げさせる。
  // 送り直しで一覧が新しくなったときも、無効になっていたボタンから外れたフォーカスを戻す。
  useEffect(() => {
    headingRef.current?.focus();
  }, [failures]);

  return (
    <section className="issue-draft-editor" aria-label="画像の送信結果">
      <h3 ref={headingRef} className="issue-draft-section-title" tabIndex={-1}>
        下書きを作りました
      </h3>
      <p key={announced.round} className="error-message issue-draft-image-alert" role="alert">
        下書きは作れましたが、次の画像は付けられませんでした。
      </p>
      <ul className="issue-draft-image-failures">
        {failures.map((failure) => (
          <li key={failure.label}>
            <strong>{failure.label}</strong>: {failure.reason}
          </li>
        ))}
      </ul>
      <p className="issue-draft-editor-hint">題名と説明は下書きに保存されています。</p>
      {/* 狭い幅で 44px にする目印 (styles/issue-reports.css。bdboard-8zwi) */}
      <div className="issue-draft-editor-actions issue-draft-image-failure-actions">
        <button type="button" className="btn" disabled={sending} onClick={onRetry}>
          {sending ? '送信中…' : '付かなかった画像をもう一度送る'}
        </button>
        <button type="button" className="btn" disabled={sending} onClick={onOpen}>
          下書きを開く
        </button>
      </div>
    </section>
  );
}
