import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http';
import { LOCAL_FILE_ACCESS_HELP, isLocalFileAccessDenied, localFileErrorMessage } from './localFileErrorMessage';

describe('localFileErrorMessage', () => {
  it('maps status codes to the viewer copy', () => {
    expect(localFileErrorMessage(new ApiError(413, 'big'))).toBe('ファイルが大きすぎて表示できません。');
    expect(localFileErrorMessage(new ApiError(415, 'type'))).toBe('この種類のファイルは表示できません。');
    expect(localFileErrorMessage(new ApiError(403, 'remote'))).toBe(LOCAL_FILE_ACCESS_HELP);
    expect(localFileErrorMessage(new ApiError(400, 'bad'))).toBe(
      'ファイルが見つからないか、開けない場所にあります。',
    );
    expect(localFileErrorMessage(new ApiError(404, 'missing'))).toBe(
      'ファイルが見つからないか、開けない場所にあります。',
    );
    expect(localFileErrorMessage(new ApiError(500, 'down'))).toBe('ファイルを読み込めませんでした。');
    expect(localFileErrorMessage(new Error('network'))).toBe('ファイルを読み込めませんでした。');
  });

  it('tells an unauthorized tunnel session how to get access', () => {
    expect(LOCAL_FILE_ACCESS_HELP).toContain('スマホ公開');
    expect(isLocalFileAccessDenied(new ApiError(403, 'local access only'))).toBe(true);
    expect(isLocalFileAccessDenied(new ApiError(404, 'missing'))).toBe(false);
    expect(isLocalFileAccessDenied(new Error('network'))).toBe(false);
  });
});
