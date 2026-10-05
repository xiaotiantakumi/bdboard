/** bdboard-4y8q.6.4: report() が受け付ける source の語彙 (api:<METHOD> <route>)。 */
import { describe, expect, it } from 'vitest';
import {
  SELF_ERROR_SOURCE_MAX_LENGTH,
  isReportableSelfErrorSource,
  selfErrorApiSource,
} from './self-error-source.js';

describe('selfErrorApiSource', () => {
  it('joins the method and the registered route pattern', () => {
    expect(selfErrorApiSource('GET', '/api/tickets/:id')).toBe('api:GET /api/tickets/:id');
    expect(selfErrorApiSource('get', '/api/tickets/:id{.+}')).toBe('api:GET /api/tickets/:id{.+}');
    expect(selfErrorApiSource('POST', '/*')).toBe('api:POST /*');
    expect(selfErrorApiSource('GET', '*')).toBe('api:GET *');
  });

  it('turns a method outside the allow list into OTHER and a route outside the grammar into (unknown route)', () => {
    expect(selfErrorApiSource('PURGE', '/api/x')).toBe('api:OTHER /api/x');
    expect(selfErrorApiSource('GET', '')).toBe('api:GET (unknown route)');
    expect(selfErrorApiSource('GET', '/api/tickets/bdboard xyz')).toBe('api:GET (unknown route)');
    expect(selfErrorApiSource('GET', 'api/no-leading-slash')).toBe('api:GET (unknown route)');
    expect(selfErrorApiSource('GET', `/${'a'.repeat(SELF_ERROR_SOURCE_MAX_LENGTH)}`)).toBe('api:GET (unknown route)');
  });

  it('always builds something the reporter accepts', () => {
    for (const route of ['', '/', '/api/x', '/api/<script>', `/${'b'.repeat(500)}`, 'no slash', '/a b']) {
      expect(isReportableSelfErrorSource(selfErrorApiSource('GET', route))).toBe(true);
    }
  });
});

describe('isReportableSelfErrorSource', () => {
  it.each([
    'api:GET /api/tickets/:id',
    'api:GET /api/tickets/:id{.+}',
    'api:DELETE /api/tickets/:id/labels/:label',
    'api:OPTIONS /*',
    'api:GET *',
    'api:OTHER /api/x',
    'api:GET (unknown route)',
  ])('accepts %s', (source) => {
    expect(isReportableSelfErrorSource(source)).toBe(true);
  });

  it.each([
    '',
    'manual',
    'api:',
    'api:GET',
    'api:GET ',
    'api:get /api/x',
    'api:FETCH /api/x',
    'api:GET api/x',
    'api:GET /api/tickets/bdboard xyz',
    'api:GET /api/x\n/api/y',
    'api:GET /api/<img src=x>',
    'api:GET /api/x "quoted"',
    'api:GET /api/x%2e%2e',
    'bd-refresh:unknown',
    'bd-refresh:unknown extra',
    'screen:render',
    ' api:GET /api/x',
    `api:GET /${'a'.repeat(SELF_ERROR_SOURCE_MAX_LENGTH)}`,
  ])('rejects %j', (source) => {
    expect(isReportableSelfErrorSource(source)).toBe(false);
  });
});
