import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { clipboardCarriesText, dragCarriesFiles, isTextEntryField, screenIssueDraftImages } from './issueDraftImages';
import type { PickedImage } from './issueDraftImageUpload';

/** 書く画面の form へ広げる処理 (formHandlers)。 */
export interface IssueDraftFormHandlers {
  readonly onPaste: ((event: ClipboardEvent<HTMLElement>) => void) | undefined;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface UseIssueDraftImages {
  readonly images: readonly PickedImage[];
  /** 直近の追加で断った理由。次の追加で置き換わり、外すと消える。 */
  readonly problems: readonly string[];
  /** 直近の「付けた」「外した」を伝える文 (読み上げ用。bdboard-8zwi)。次の操作で置き換わり、何も付かなかった追加では空になる。 */
  readonly notice: string;
  readonly addFiles: (files: readonly File[]) => void;
  readonly remove: (id: string) => void;
  /** 書く画面の onPaste へ渡す。画像を含む貼り付けだけを引き受ける (文字の欄へ文字と画像が一緒に来たときは、文字を優先して引き受けない)。 */
  readonly handlePaste: (event: ClipboardEvent<HTMLElement>) => void;
  /** 書く画面の form へ広げる処理 (ローカルで開いているときだけ渡す)。`sending` は送信中か。 */
  readonly formHandlers: (sending: boolean) => IssueDraftFormHandlers;
}

/**
 * 「新しく報告」で下書きに付ける画像の状態 (bdboard-4y8q.6.9)。付ける前の検査は screenIssueDraftImages。
 * 中身 (base64) はここでは読まない: 縮小表示は File から作り、送る直前に 1 枚ずつ読む (issueDraftImageUpload.ts)。
 */
export function useIssueDraftImages(): UseIssueDraftImages {
  const [images, setImages] = useState<PickedImage[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  // 枚数の検査は state ではなくこの ref の最新値で行う。同じイベントの中で続けて追加されても (貼り付けと選択が重なるなど)、
  // 描画を待たずに前の追加ぶんを数えて、上限を超えさせない。
  const imagesRef = useRef<PickedImage[]>([]);
  const nextId = useRef(0);

  const addFiles = (files: readonly File[]) => {
    const screened = screenIssueDraftImages(imagesRef.current.length, files);
    const added = screened.accepted.map((file) => {
      nextId.current += 1;
      return {
        id: `draft-image-${nextId.current}`,
        file,
        name: file.name === '' ? `貼り付け画像 ${nextId.current}` : file.name,
      };
    });
    imagesRef.current = [...imagesRef.current, ...added];
    setImages(imagesRef.current);
    setProblems(screened.problems);
    // 画面の変化は見えるが読み上げには届かないので、付いた枚数を polite な status で伝える (断った理由は alert の側が読む)。
    setNotice(added.length === 0 ? '' : `${added.length} 枚の画像を付けました (全部で ${imagesRef.current.length} 枚)。`);
  };

  const remove = (id: string) => {
    const removed = imagesRef.current.find((image) => image.id === id);
    imagesRef.current = imagesRef.current.filter((image) => image.id !== id);
    setImages(imagesRef.current);
    setProblems([]);
    setNotice(removed === undefined ? '' : `「${removed.name}」を外しました (全部で ${imagesRef.current.length} 枚)。`);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    // 一覧に無い形式 (SVG・BMP など) も image/ で始まれば引き受け、画面に断る理由を出す。
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    // 文字だけの貼り付けは止めない (欄へふつうに入る)。止めるのは画像を含むときだけ。
    if (imageFiles.length === 0) {
      return;
    }
    // Excel・Word のように文字と画像が一緒に来たとき、文字の欄 (題名・説明) へ貼るなら画像は引き受けず、文字を入れる (bdboard-8zwi)。
    // 画像は「画像を選ぶ」から付けられる。文字の欄ではない所 (フォームの余白・ボタンなど) は、文字を受ける先が無いので画像を付ける。
    if (isTextEntryField(event.target) && clipboardCarriesText(event.clipboardData)) {
      return;
    }
    event.preventDefault();
    addFiles(imageFiles);
  };

  /**
   * 貼り付けは送信中は受けない。ファイルのドラッグは、画像の欄の外 (説明の欄など) に落としても受ける: 受けないと、
   * ブラウザが落としたファイルを開いてページを移り、書きかけの題名・説明が消える。欄のドロップ領域が先に受けたもの
   * (preventDefault 済み) は重ねて足さない。送信中に落としたものは、ページを移らせずに捨てる。文字のドラッグには触らない。
   */
  const formHandlers = (sending: boolean): IssueDraftFormHandlers => ({
    onPaste: sending ? undefined : handlePaste,
    onDragOver: (event) => {
      if (dragCarriesFiles(event.dataTransfer)) event.preventDefault();
    },
    onDrop: (event) => {
      if (event.defaultPrevented || !dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (!sending) addFiles(Array.from(event.dataTransfer.files));
    },
  });

  return { images, problems, notice, addFiles, remove, handlePaste, formHandlers };
}
