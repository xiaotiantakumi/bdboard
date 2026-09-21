// bdboard-sso1.48: SearchPalette.tsx の「行の実行(クリック/Enter)とキーボード
// 選択(↑↓/Enter/IME中Enter無視)」を、挙動を変えずにこのカスタムフックへ
// 抽出しただけのファイル。handleInputKeyDown は移動前から useCallback で
// 包んでいない(毎レンダー新規生成のままで、onKeyDown へインラインで渡す
// 用途しか無いため)。
import { useCallback } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { isImeComposingKeyEvent } from '../../imeGuard';
import type { PaletteRow } from './types';

export interface UsePaletteActivationOptions {
  rows: PaletteRow[];
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  requestCloseThen: (run: () => void) => void;
  onSelect: (ticketId: string) => void;
}

export interface UsePaletteActivationResult {
  handleActivateRow: (row: PaletteRow) => void;
  handleInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function usePaletteActivation({
  rows,
  selectedIndex,
  setSelectedIndex,
  requestCloseThen,
  onSelect,
}: UsePaletteActivationOptions): UsePaletteActivationResult {
  // 行の実行は selectTicket やパネル open など、自前の history エントリを push/replace しうる。
  // 先に実行してから back() すると「たった今積まれた遷移先のエントリ」を pop してしまい、
  // 逆に back() せずエントリを手放すと死にエントリが積み上がって
  // useTicketDeepLink.closeDetail() の「1回 back すれば詳細が閉じる」前提を壊す (PR#303 レビュー)。
  // そこで back() でパレットのエントリを確実に消費し、popstate の着地後に実行する。
  const handleActivateRow = useCallback(
    (row: PaletteRow) => {
      requestCloseThen(() => {
        if (row.kind === 'action') {
          row.action.onSelect();
        } else {
          onSelect(row.ticket.id);
        }
      });
    },
    [requestCloseThen, onSelect],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyEvent(event)) {
      return;
    }

    if (event.key === 'ArrowDown' && rows.length > 0) {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, rows.length - 1));
      return;
    }

    if (event.key === 'ArrowUp' && rows.length > 0) {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter' && rows.length > 0) {
      event.preventDefault();
      const row = rows[selectedIndex];
      if (row !== undefined) {
        handleActivateRow(row);
      }
    }
  };

  return { handleActivateRow, handleInputKeyDown };
}
