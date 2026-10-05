import { vi } from 'vitest';

/**
 * URL.createObjectURL / revokeObjectURL を差し替える。テスト環境の URL は Node 側の実装で、blob:nodedata: を
 * 作って手放さないため、作った数・手放した数を見たいテストでは差し替える。戻り値の関数で元の定義に戻す。
 */
function replaceObjectUrls(create: unknown, revoke: unknown): () => void {
  const originals = {
    createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  };
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
  return () => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(URL, key);
      } else {
        Object.defineProperty(URL, key, descriptor);
      }
    }
  };
}

/** 数えられる object URL の差し替え。作る URL は blob:preview-1, blob:preview-2, ... の順。afterEach で restore を呼ぶ。 */
export function stubObjectUrls() {
  let counter = 0;
  const create = vi.fn((_file: unknown) => {
    counter += 1;
    return `blob:preview-${counter}`;
  });
  const revoke = vi.fn((_url: string) => undefined);
  return { create, revoke, restore: replaceObjectUrls(create, revoke) };
}

/** object URL を作れない環境 (関数が無い) の再現。戻り値の関数で元の定義に戻す。 */
export function hideObjectUrls(): () => void {
  return replaceObjectUrls(undefined, undefined);
}
