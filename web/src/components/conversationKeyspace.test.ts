import { describe, expect, it } from 'vitest';
import {
  isEmptyList,
  isEmptyText,
  isNeverEmpty,
  migrateKeyInRecord,
  purgeKeysInRecord,
} from './conversationKeyspace';

describe('migrateKeyInRecord', () => {
  it('returns the same reference when from is absent', () => {
    const record = { 'new:proj-a:0': 'hello' };
    expect(migrateKeyInRecord(record, 'new:proj-a:1', 'new:proj-a:2', isEmptyText)).toBe(record);
  });

  it('drops from when the source is empty text without creating to', () => {
    const record = { 'new::0': '', 'new:proj-a:0': 'keep' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:0': 'keep' });
    expect(next).not.toBe(record);
    expect(record).toEqual({ 'new::0': '', 'new:proj-a:0': 'keep' });
  });

  it('drops from without overwriting when to already has content', () => {
    const record = { 'new::0': 'draft', 'new:proj-a:1': 'existing' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:1': 'existing' });
  });

  it('overwrites to when to is empty text', () => {
    const record = { 'new::0': 'draft', 'new:proj-a:1': '' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:1': 'draft' });
  });

  it('migrates when to is undefined', () => {
    const record = { 'new::0': 'draft' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:1': 'draft' });
  });

  it('migrates empty text when isNeverEmpty is used', () => {
    const record = { 'new::0': '' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isNeverEmpty);
    expect(next).toEqual({ 'new:proj-a:1': '' });
    expect(migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText)).toEqual({});
  });

  it('drops empty lists and migrates non-empty lists', () => {
    const emptyRecord = { 'new::0': [] as string[] };
    expect(migrateKeyInRecord(emptyRecord, 'new::0', 'new:proj-a:1', isEmptyList)).toEqual({});

    const filledRecord = { 'new::0': ['a'] };
    expect(migrateKeyInRecord(filledRecord, 'new::0', 'new:proj-a:1', isEmptyList)).toEqual({
      'new:proj-a:1': ['a'],
    });
  });

  it('does not mutate the original record', () => {
    const record = { 'new::0': 'draft', 'new:proj-a:1': 'existing' };
    const snapshot = { ...record, 'new::0': 'draft' };
    migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(record).toEqual(snapshot);
  });
});

describe('purgeKeysInRecord', () => {
  it('returns the same reference when nothing matches', () => {
    const record = { 'new:proj-a:0': 'hello' };
    expect(purgeKeysInRecord(record, (key) => key.startsWith('new::'))).toBe(record);
  });

  it('removes all matching keys', () => {
    const record = {
      'new::0': 'a',
      'new::1': 'b',
      'new:proj-a:0': 'keep',
    };
    const next = purgeKeysInRecord(record, (key) => /^new::/.test(key));
    expect(next).toEqual({ 'new:proj-a:0': 'keep' });
  });

  it('does not mutate the original record', () => {
    const record = { 'new::0': 'a', 'new:proj-a:0': 'keep' };
    const snapshot = { ...record };
    purgeKeysInRecord(record, (key) => key.startsWith('new::'));
    expect(record).toEqual(snapshot);
  });
});
