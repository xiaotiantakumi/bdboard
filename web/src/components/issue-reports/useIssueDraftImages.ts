import { useRef, useState, type ClipboardEvent } from 'react';
import { screenIssueDraftImages } from './issueDraftImages';
import type { PickedImage } from './issueDraftImageUpload';

export interface UseIssueDraftImages {
  readonly images: readonly PickedImage[];
  /** 直近の追加で断った理由。次の追加で置き換わり、外すと消える。 */
  readonly problems: readonly string[];
  readonly addFiles: (files: readonly File[]) => void;
  readonly remove: (id: string) => void;
  /** 書く画面の onPaste へ渡す。画像を含む貼り付けだけを引き受ける。 */
  readonly handlePaste: (event: ClipboardEvent<HTMLElement>) => void;
}

/**
 * 「新しく報告」で下書きに付ける画像の状態 (bdboard-4y8q.6.9)。付ける前の検査は screenIssueDraftImages。
 * 中身 (base64) はここでは読まない: 縮小表示は File から作り、送る直前に 1 枚ずつ読む (issueDraftImageUpload.ts)。
 */
export function useIssueDraftImages(): UseIssueDraftImages {
  const [images, setImages] = useState<PickedImage[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
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
  };

  const remove = (id: string) => {
    imagesRef.current = imagesRef.current.filter((image) => image.id !== id);
    setImages(imagesRef.current);
    setProblems([]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    // 一覧に無い形式 (SVG・BMP など) も image/ で始まれば引き受け、画面に断る理由を出す。
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    // 文字だけの貼り付けは止めない (欄へふつうに入る)。止めるのは画像を含むときだけ。
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addFiles(imageFiles);
  };

  return { images, problems, addFiles, remove, handlePaste };
}
