import { useEffect, useRef } from 'react';

export interface HeaderSearchFieldProps {
  value: string;
  onChange: (text: string) => void;
  /** モバイルで検索欄を閉じる。指定があると右端に閉じるボタンを出す。 */
  onClose?: () => void;
  autoFocus?: boolean;
}

/**
 * ヘッダーの検索欄。ボードのチケットをタイトル/IDで絞り込む (旧「絞り込み」の入力欄)。
 * コマンドパレットは Cmd+K / ⋯ メニューから開く。
 */
export function HeaderSearchField({
  value,
  onChange,
  onClose,
  autoFocus = false,
}: HeaderSearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  return (
    <div className="header-search" role="search">
      <input
        ref={inputRef}
        type="search"
        className="header-search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && onClose !== undefined) {
            onClose();
          }
        }}
        placeholder="タイトル/IDで検索"
        aria-label="チケットの検索"
      />
      {onClose !== undefined && (
        <button
          type="button"
          className="header-icon-btn"
          aria-label="検索を閉じる"
          onClick={onClose}
        >
          ✕
        </button>
      )}
    </div>
  );
}
