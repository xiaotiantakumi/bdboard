import { describe, expect, it } from 'vitest';
import { generatePassphrase, getPassphraseWordList } from './passphrase.js';

const PASSPHRASE_PATTERN = /^[a-z]+-[a-z]+-\d{2}$/;

describe('generatePassphrase', () => {
  it('produces deterministic output with a fixed random sequence', () => {
    const values = [0, 0, 0];
    let index = 0;
    const random = (): number => {
      const value = values[index] ?? 0;
      index += 1;
      return value;
    };

    const words = getPassphraseWordList();
    const expected = `${words[0]}-${words[0]}-10`;
    expect(generatePassphrase(random)).toBe(expected);
  });

  it('has at least 64 unique lowercase words', () => {
    const words = getPassphraseWordList();
    expect(words.length).toBeGreaterThanOrEqual(64);

    const unique = new Set(words);
    expect(unique.size).toBe(words.length);

    for (const word of words) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it('always matches the passphrase pattern over 1000 random generations', () => {
    for (let i = 0; i < 1000; i += 1) {
      const passphrase = generatePassphrase(Math.random);
      expect(passphrase).toMatch(PASSPHRASE_PATTERN);
    }
  });

  it('produces mostly unique passphrases over 1000 generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generatePassphrase(Math.random));
    }
    expect(seen.size).toBeGreaterThanOrEqual(950);
  });

  it('does not access out of bounds at boundary random values', () => {
    const boundaryValues = [0, 0.999999, 1, -0.1];
    for (const value of boundaryValues) {
      expect(() => generatePassphrase(() => value)).not.toThrow();
      expect(generatePassphrase(() => value)).toMatch(PASSPHRASE_PATTERN);
    }
  });
});
