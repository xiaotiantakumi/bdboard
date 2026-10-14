import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { IssueDraftSummaryDto } from '../../api/issue-reports';
import { useMountedRef } from '../../hooks/useMountedRef';
import type { IssueDraftImageFailureItem } from './IssueDraftImageFailures';
import { findImagesAlreadyStored } from './issueDraftImageResend';
import { uploadIssueDraftImages, type ImageUploadFailure, type PickedImage } from './issueDraftImageUpload';

/** 下書きは作れたが、画像が付かなかったもの。ここにある間は、書く画面の代わりに失敗の画面を出す。 */
export interface PartialOutcome {
  readonly draft: IssueDraftSummaryDto;
  readonly failures: readonly ImageUploadFailure[];
  /** サーバーに付いたと分かっている画像の、サーバー側の file 名。送り直しで同じ画像を二重に付けない目印 (issueDraftImageResend.ts)。 */
  readonly storedFileNames: ReadonlySet<string>;
}

export interface UseIssueDraftImageSendOptions {
  /** 書く画面で付けている画像 (失敗の一覧の位置と、送り直す画像の取り出しに使う)。 */
  readonly images: readonly PickedImage[];
  readonly onCreated: (draft: IssueDraftSummaryDto) => void;
  /** 失敗の画面を出しているかが変わったときに呼ぶ (閉じるときは false)。 */
  readonly onResultShownChange?: ((shown: boolean) => void) | undefined;
}

export interface UseIssueDraftImageSend {
  /** 「画像を送っています (sent / total)」の数。送っていないときは null。 */
  readonly progress: { readonly sent: number; readonly total: number } | null;
  /** 画像が付かなかった結果。null の間は書く画面を出す。 */
  readonly partial: PartialOutcome | null;
  /** 失敗の画面に出す一覧 (内容が変わらないうちは同じ配列)。 */
  readonly failureItems: readonly IssueDraftImageFailureItem[];
  /** 作れた下書きへ画像を送り、一覧を読み直して、全部付けば onCreated、付かなかった分があれば失敗の画面を出す。 */
  readonly finishCreated: (draft: IssueDraftSummaryDto, targets: readonly PickedImage[]) => Promise<void>;
  /** 失敗の画面の「付かなかった画像をもう一度送る」。 */
  readonly retry: (outcome: PartialOutcome) => Promise<void>;
}

/**
 * 「新しく報告」の、下書きを作ったあとの画像の送信と、付かなかった画像の送り直し (bdboard-4y8q.6.9・bdboard-8zwi)。
 * 送信中かどうか (sending) は書く画面が持つ: ここは待つだけで、フラグには触れない。
 */
export function useIssueDraftImageSend({
  images,
  onCreated,
  onResultShownChange,
}: UseIssueDraftImageSendOptions): UseIssueDraftImageSend {
  const queryClient = useQueryClient();
  const mounted = useMountedRef();
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [partial, setPartial] = useState<PartialOutcome | null>(null);

  const resultShown = partial !== null;
  useEffect(() => {
    onResultShownChange?.(resultShown);
    return () => onResultShownChange?.(false);
  }, [resultShown, onResultShownChange]);

  // 失敗の一覧に出す名前。同じ名前の画像を見分けるため、送る前の一覧での位置を付ける。
  const failureItems = useMemo(
    () =>
      (partial?.failures ?? []).map((failure) => ({
        label: `${images.findIndex((image) => image.id === failure.id) + 1} 枚目「${failure.name}」`,
        reason: failure.reason,
      })),
    [partial, images],
  );

  /**
   * 画像を送り、一覧を読み直して、全部付いたら下書きを選ばせる。付かなかった分があれば失敗の画面を (新しく) 出す。
   * 送る画像が無ければ (画像なし・トンネル) 送信も進み具合も出さず、読み直しと onCreated だけ。
   * `knownFileNames` は、前の回までに付いたと分かっている画像のサーバー側の file 名 (送り直しのとき)。
   */
  const send = async (
    draft: IssueDraftSummaryDto,
    targets: readonly PickedImage[],
    knownFileNames: ReadonlySet<string>,
  ) => {
    let failures: readonly ImageUploadFailure[] = [];
    const storedFileNames = new Set(knownFileNames);
    if (targets.length > 0) {
      failures = await uploadIssueDraftImages(
        draft.id,
        targets,
        (sent, total) => setProgress({ sent, total }),
        (_image, fileName) => storedFileNames.add(fileName),
      );
      setProgress(null);
    }
    await queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
    // 送っている間に一覧から別の下書きを選ぶと、この画面は閉じる。画像は送り終えて一覧も読み直すが、作った下書きを選び直して
    // 利用者が選んだ下書きを奪わない (付いた画像は、その下書きを開けば見られる)。
    if (!mounted.current) return;
    if (failures.length === 0) {
      onCreated(draft);
    } else {
      setPartial({ draft, failures, storedFileNames });
    }
  };

  const retry = async (outcome: PartialOutcome) => {
    const failedIds = new Set(outcome.failures.map((failure) => failure.id));
    const maybeStoredIds = new Set(outcome.failures.filter((failure) => failure.mayBeStored === true).map((failure) => failure.id));
    const failed = images.filter((image) => failedIds.has(image.id));
    // 送ったのに応答が届かなかった画像は、サーバーに保存できているかもしれない。同じ画像を二重に付けないよう、送る前に下書きの画像を
    // 取り直して、もう付いているものは送らない (サーバーが断った失敗は付いていないので、確かめない)。bdboard-8zwi。
    const alreadyStored = await findImagesAlreadyStored(
      outcome.draft.id,
      failed.filter((image) => maybeStoredIds.has(image.id)),
      outcome.storedFileNames,
    );
    await send(
      outcome.draft,
      failed.filter((image) => !alreadyStored.has(image.id)),
      new Set([...outcome.storedFileNames, ...alreadyStored.values()]),
    );
  };

  return { progress, partial, failureItems, finishCreated: (draft, targets) => send(draft, targets, new Set()), retry };
}
