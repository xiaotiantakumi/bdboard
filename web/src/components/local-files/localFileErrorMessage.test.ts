import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http';
import { localFileErrorMessage } from './localFileErrorMessage';

describe('localFileErrorMessage', () => {
  it('maps status codes to the viewer copy', () => {
    expect(localFileErrorMessage(new ApiError(413, 'big'))).toBe('ファイルが大きすぎて表示できません。');
    expect(localFileErrorMessage(new ApiError(415, 'type'))).toBe('この種類のファイルは表示できません。');
    expect(localFileErrorMessage(new ApiError(403, 'remote'))).toBe('ローカルで開いたときだけ表示できます。');
    expect(localFileErrorMessage(new ApiError(400, 'bad'))).toBe(
      'ファイルが見つからないか、開けない場所にあります。',
    );
    expect(localFileErrorMessage(new ApiError(404, 'missing'))).toBe(
      'ファイルが見つからないか、開けない場所にあります。',
    );
    expect(localFileErrorMessage(new ApiError(500, 'down'))).toBe('ファイルを読み込めませんでした。');
    expect(localFileErrorMessage(new Error('network'))).toBe('ファイルを読み込めませんでした。');
  });
});
