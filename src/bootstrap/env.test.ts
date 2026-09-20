import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  envBool,
  envBoolDefaultTrue,
  envFloat,
  envInt,
  envOptionalString,
  envString,
} from './env.js';

const KEY = 'BDBOARD_TEST_ENV_VALUE';

describe('env helpers (bdboard-sso1.9 move only)', () => {
  beforeEach(() => {
    delete process.env[KEY];
  });

  afterEach(() => {
    delete process.env[KEY];
  });

  it('envString falls back to the default when unset or empty', () => {
    expect(envString(KEY, 'fallback')).toBe('fallback');
    process.env[KEY] = '';
    expect(envString(KEY, 'fallback')).toBe('fallback');
    process.env[KEY] = 'value';
    expect(envString(KEY, 'fallback')).toBe('value');
  });

  it('envOptionalString returns undefined when unset or empty', () => {
    expect(envOptionalString(KEY)).toBeUndefined();
    process.env[KEY] = '';
    expect(envOptionalString(KEY)).toBeUndefined();
    process.env[KEY] = 'value';
    expect(envOptionalString(KEY)).toBe('value');
  });

  it('envBool defaults to false and accepts 1/true (case-insensitive)', () => {
    expect(envBool(KEY)).toBe(false);
    process.env[KEY] = '1';
    expect(envBool(KEY)).toBe(true);
    process.env[KEY] = 'TRUE';
    expect(envBool(KEY)).toBe(true);
    process.env[KEY] = '0';
    expect(envBool(KEY)).toBe(false);
    process.env[KEY] = 'nonsense';
    expect(envBool(KEY)).toBe(false);
  });

  it('envBoolDefaultTrue defaults to true and treats 0/false as opt-out', () => {
    expect(envBoolDefaultTrue(KEY)).toBe(true);
    process.env[KEY] = '0';
    expect(envBoolDefaultTrue(KEY)).toBe(false);
    process.env[KEY] = 'FALSE';
    expect(envBoolDefaultTrue(KEY)).toBe(false);
    process.env[KEY] = 'anything-else';
    expect(envBoolDefaultTrue(KEY)).toBe(true);
  });

  it('envInt parses integers and falls back on NaN/unset', () => {
    expect(envInt(KEY, 42)).toBe(42);
    process.env[KEY] = '7';
    expect(envInt(KEY, 42)).toBe(7);
    process.env[KEY] = 'not-a-number';
    expect(envInt(KEY, 42)).toBe(42);
  });

  it('envFloat parses positive floats and rejects <=0/NaN', () => {
    expect(envFloat(KEY, 1.5)).toBe(1.5);
    process.env[KEY] = '2.75';
    expect(envFloat(KEY, 1.5)).toBe(2.75);
    process.env[KEY] = '0';
    expect(envFloat(KEY, 1.5)).toBe(1.5);
    process.env[KEY] = '-3';
    expect(envFloat(KEY, 1.5)).toBe(1.5);
    process.env[KEY] = 'nope';
    expect(envFloat(KEY, 1.5)).toBe(1.5);
  });
});
