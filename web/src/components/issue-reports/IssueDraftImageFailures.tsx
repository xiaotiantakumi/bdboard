import { useEffect, useRef } from 'react';

export interface IssueDraftImageFailuresProps {
  readonly failures: readonly { readonly label: string; readonly reason: string }[];
  readonly sending: boolean;
  readonly onRetry: () => void;
  readonly onOpen: () => void;
}

export function IssueDraftImageFailures({ failures, sending, onRetry, onOpen }: IssueDraftImageFailuresProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  return (
    <section className="issue-draft-editor" aria-label="画像の送信結果">
      <h3 ref={headingRef} tabIndex={-1}>下書きを作りました</h3>
      <p role="alert">下書きは作れましたが、次の画像は付けられませんでした。</p>
      <ul>{failures.map((failure) => <li key={`${failure.label}-${failure.reason}`}><strong>{failure.label}:</strong> {failure.reason}</li>)}</ul>
      <p>題名と説明は下書きに保存されています。</p>
      <div className="issue-draft-editor-actions">
        <button type="button" className="btn" disabled={sending} onClick={onRetry}>{sending ? '送信中…' : '付かなかった画像をもう一度送る'}</button>
        <button type="button" className="btn" onClick={onOpen}>下書きを開く</button>
      </div>
    </section>
  );
}
