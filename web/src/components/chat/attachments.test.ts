import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from './attachments';
import {
  attachmentsToPayload,
  formatImageSize,
  readFileAsDataUrl,
  validateChatAttachments,
} from './attachments';

function attachment(id: string, size = 1, mimeType: ChatAttachment['mimeType'] = 'image/png'): ChatAttachment {
  const file = new File(['x'], `${id}.png`, { type: mimeType });
  return {
    id,
    file,
    mimeType,
    previewUrl: `data:${mimeType};base64,${id}`,
    name: `${id}.png`,
    size,
  };
}

function file(name: string, type: string, size = 1): File {
  const result = new File(['x'], name, { type });
  Object.defineProperty(result, 'size', { value: size });
  return result;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('validateChatAttachments', () => {
  it('対応する PNG・JPEG・WebP を許可する', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(validateChatAttachments([], [file('a', type)])).toBeNull();
    }
  });

  it.each(['image/gif', 'application/pdf'])('非対応 MIME タイプ %s を拒否する', (type) => {
    expect(validateChatAttachments([], [file('a', type)])).toBe('PNG・JPEG・WebP 形式の画像だけ貼り付けられます。');
  });

  it('画像枚数は合計4枚まで許可し、5枚を拒否する', () => {
    expect(validateChatAttachments([attachment('1'), attachment('2')], [file('3', 'image/png'), file('4', 'image/png')])).toBeNull();
    expect(validateChatAttachments([attachment('1'), attachment('2')], [file('3', 'image/png'), file('4', 'image/png'), file('5', 'image/png')])).toBe('画像は最大 4 枚まで添付できます。');
  });

  it('ファイルサイズは5 MiBちょうどを許可し、超過を拒否する', () => {
    expect(validateChatAttachments([], [file('exact.png', 'image/png', 5 * 1024 * 1024)])).toBeNull();
    expect(validateChatAttachments([], [file('large.png', 'image/png', 5 * 1024 * 1024 + 1)])).toBe('「large.png」は 5 MiB を超えています。');
    expect(validateChatAttachments([], [file('', 'image/png', 5 * 1024 * 1024 + 1)])).toBe('「名称なしの画像」は 5 MiB を超えています。');
  });

  it('既存分と追加分の合計10 MiBちょうどを許可し、超過を拒否する', () => {
    expect(validateChatAttachments([attachment('old', 5 * 1024 * 1024)], [file('new.png', 'image/png', 5 * 1024 * 1024)])).toBeNull();
    // incoming 単体は5 MiB以内(個別サイズ判定は通過)のまま、既存分と合わせて10 MiBを
    // 超えるようにする(既存分は個別サイズ判定の対象外なので6 MiBでも許容される)。
    expect(validateChatAttachments([attachment('old', 6 * 1024 * 1024)], [file('new.png', 'image/png', 5 * 1024 * 1024)])).toBe('画像の合計サイズは 10 MiB 以下にしてください。');
  });

  it('すべての条件を通過した入力を許可する', () => {
    expect(validateChatAttachments([], [file('ok.png', 'image/png', 10)])).toBeNull();
  });

  it('複数条件に違反する場合は MIME タイプのエラーを優先する', () => {
    expect(validateChatAttachments([attachment('1'), attachment('2'), attachment('3'), attachment('4')], [file('bad.gif', 'image/gif', 5 * 1024 * 1024 + 1)])).toBe('PNG・JPEG・WebP 形式の画像だけ貼り付けられます。');
  });
});

describe('readFileAsDataUrl', () => {
  it('File を data URL 文字列に変換する', async () => {
    const result = await readFileAsDataUrl(new File(['hello'], 'a.png', { type: 'image/png' }));
    expect(typeof result).toBe('string');
    expect(result.startsWith('data:')).toBe(true);
  });

  it('FileReader の error イベントで reject する', async () => {
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new Event('error'));
    });
    await expect(readFileAsDataUrl(new File(['x'], 'a.png', { type: 'image/png' }))).rejects.toThrow('画像を読み込めませんでした。');
  });
});

describe('attachmentsToPayload', () => {
  it('順序と件数を保ち、data URL のカンマ以降を payload にする', () => {
    const items = [
      { ...attachment('one', 1, 'image/png'), previewUrl: 'data:image/png;base64,AAAA' },
      { ...attachment('two', 1, 'image/jpeg'), previewUrl: 'data:image/jpeg;base64,BBBB' },
    ];
    expect(attachmentsToPayload(items)).toEqual([
      { mimeType: 'image/png', data: 'AAAA' },
      { mimeType: 'image/jpeg', data: 'BBBB' },
    ]);
    expect(attachmentsToPayload([])).toEqual([]);
  });

  it('カンマのない previewUrl ではエラーを投げる', () => {
    expect(() => attachmentsToPayload([{ ...attachment('bad'), previewUrl: 'not-a-data-url' }])).toThrow('画像を送信形式に変換できませんでした。');
  });
});

describe('formatImageSize', () => {
  it.each([[0, '1 KiB'], [1024, '1 KiB'], [1025, '2 KiB'], [1024 * 1024 - 1, '1024 KiB']])('%i bytes を KiB 表記にする', (bytes, expected) => {
    expect(formatImageSize(bytes)).toBe(expected);
  });

  it('MiB 閾値ちょうどから小数1桁で表記する', () => {
    expect(formatImageSize(1024 * 1024)).toBe('1.0 MiB');
    expect(formatImageSize(1024 * 1024 * 2.5)).toBe('2.5 MiB');
  });
});
