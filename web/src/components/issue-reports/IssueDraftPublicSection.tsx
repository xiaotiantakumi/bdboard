import { useState } from 'react';
import type { IssueDraftDetailDto, IssueDraftEditResponseDto } from '../../api/issue-reports';
import { togglePressedProps } from '../toggleGroupA11y';
import { IssueDraftEditor } from './IssueDraftEditor';
import { describeLeaks, omittedLeakCount, segmentMarkedText } from './issueDraftText';
import { SafeMarkdownPreview } from './SafeMarkdownPreview';

type PublicMode = 'preview' | 'raw' | 'edit';

export interface IssueDraftPublicSectionProps {
  readonly draft: IssueDraftDetailDto;
  readonly onSaved: (response: IssueDraftEditResponseDto) => void;
}

function MarkedText({ text, ranges }: { readonly text: string; readonly ranges: readonly { start: number; end: number }[] }) {
  const segments = segmentMarkedText(text, ranges);
  return (
    <>
      {segments.map((segment, index) =>
        segment.mark === 'none' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <mark key={index} className={`issue-draft-mark issue-draft-mark-${segment.mark}`} data-mark={segment.mark}>
            {segment.text}
          </mark>
        ),
      )}
    </>
  );
}

function LeakWarnings({ draft }: { readonly draft: IssueDraftDetailDto }) {
  const items = describeLeaks(draft, draft.suspectedLeaks);
  const omitted = omittedLeakCount(draft.suspectedLeaksOmitted);
  if (items.length === 0 && omitted === 0) return null;
  return (
    <div className="issue-draft-leaks" role="alert">
      <p className="issue-draft-leaks-title">置き換え漏れの疑いがあります。投稿の前に確かめてください。</p>
      <ul className="issue-draft-leaks-list">
        {items.map((item) => (
          <li key={item.key}>
            <span className="issue-draft-leak-field">{item.fieldLabel}</span>
            <span className="issue-draft-leak-kind">{item.label}</span>
            {item.excerpt !== undefined ? <code className="issue-draft-leak-excerpt">{item.excerpt}</code> : null}
          </li>
        ))}
      </ul>
      {omitted !== 0 && (
        <p className="issue-draft-leaks-omitted">
          {omitted === 'some' ? 'ほかにも疑いがありますが、上限で省きました。' : `ほかに ${omitted} 件の疑いがありますが、上限で省きました。`}
        </p>
      )}
      {draft.restricted && (
        <p className="issue-draft-leaks-note">
          トンネル経由では、隠しているパスに当たるかどうかは調べません (PC のローカル画面ではパスも調べます)。
        </p>
      )}
    </div>
  );
}

/**
 * 1) 投稿される内容: GitHub での見え方 (画像・リンクを読み込まないプレビュー)、置き換えた印と疑いに印を付けた生の本文、
 * その場の編集。見送り・投稿済みの下書きは直せない (サーバーも 409 にする)。
 */
export function IssueDraftPublicSection({ draft, onSaved }: IssueDraftPublicSectionProps) {
  const [mode, setMode] = useState<PublicMode>('preview');
  const editable = draft.status === 'pending';
  const leaks = Array.isArray(draft.suspectedLeaks) ? draft.suspectedLeaks : [];
  const rangesOf = (field: 'title' | 'body') => leaks.filter((leak) => leak.field === field);
  const modes: { mode: PublicMode; label: string }[] = [
    { mode: 'preview', label: 'プレビュー' },
    { mode: 'raw', label: '生の本文' },
    ...(editable ? [{ mode: 'edit' as const, label: '直す' }] : []),
  ];

  return (
    <section className="issue-draft-section" aria-labelledby={`issue-draft-public-${draft.id}`}>
      <h3 id={`issue-draft-public-${draft.id}`} className="issue-draft-section-title">
        投稿される内容
      </h3>
      <div className="toggle-group issue-draft-mode-toggle">
        {modes.map((item) => (
          <button
            key={item.mode}
            type="button"
            className={`toggle-btn${mode === item.mode ? ' active' : ''}`}
            {...togglePressedProps(mode === item.mode)}
            onClick={() => setMode(item.mode)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <LeakWarnings draft={draft} />
      {mode === 'preview' && (
        <div className="issue-draft-preview">
          <p className="issue-draft-preview-title">{draft.title}</p>
          <SafeMarkdownPreview text={draft.body} />
        </div>
      )}
      {mode === 'raw' && (
        <div className="issue-draft-raw">
          <p className="issue-draft-raw-legend">
            <mark className="issue-draft-mark issue-draft-mark-redaction">置き換えた印</mark>
            <mark className="issue-draft-mark issue-draft-mark-leak">置き換え漏れの疑い</mark>
          </p>
          <pre className="issue-draft-raw-title">
            <MarkedText text={draft.title} ranges={rangesOf('title')} />
          </pre>
          <pre className="issue-draft-raw-body">
            <MarkedText text={draft.body} ranges={rangesOf('body')} />
          </pre>
        </div>
      )}
      {mode === 'edit' && editable && (
        <IssueDraftEditor
          key={`${draft.id}-${draft.title.length}-${draft.body.length}`}
          draft={draft}
          onCancel={() => setMode('preview')}
          onSaved={(response) => {
            setMode('preview');
            onSaved(response);
          }}
        />
      )}
    </section>
  );
}
