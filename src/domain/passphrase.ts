/** Short, easy-to-spell English words (64+). Lowercase a-z only, no duplicates. */
const WORDS: readonly string[] = [
  'apple', 'arrow', 'badge', 'beach', 'bench', 'berry', 'blade', 'blank',
  'blaze', 'bloom', 'brick', 'brook', 'cabin', 'camel', 'candy', 'cedar',
  'charm', 'chase', 'chime', 'cliff', 'cloud', 'coral', 'crane', 'creek',
  'crown', 'daisy', 'delta', 'diver', 'dodge', 'drama', 'drift', 'eagle',
  'ember', 'fable', 'fairy', 'ferry', 'field', 'flame', 'flint', 'flora',
  'forge', 'frost', 'giant', 'glass', 'globe', 'grace', 'grape', 'green',
  'grove', 'happy', 'hazel', 'heart', 'honey', 'house', 'ivory', 'jewel',
  'jolly', 'kayak', 'knack', 'lance', 'latch', 'lemon', 'light', 'linen',
  'maple', 'marsh', 'melon', 'mercy', 'metal', 'minty', 'mocha', 'mossy',
  'noble', 'north', 'ocean', 'olive', 'onion', 'orbit', 'panda', 'pearl',
  'piano', 'pilot', 'plaza', 'prism', 'proud', 'quilt', 'quiet', 'radar',
  'raven', 'river', 'robin', 'rocky', 'sandy', 'scale', 'shade', 'shark',
  'sheep', 'shine', 'shore', 'silly', 'skate', 'smile', 'snack', 'solar',
  'spark', 'spice', 'spine', 'spray', 'stone', 'storm', 'sugar', 'sunny',
  'swift', 'table', 'tiger', 'toast', 'tower', 'trail', 'tulip', 'ultra',
  'uncle', 'unity', 'valor', 'vapor', 'vivid', 'wagon', 'waltz', 'water',
  'whale', 'wheat', 'wheel', 'windy', 'witch', 'world', 'yacht', 'zebra',
] as const;

const WORD_COUNT = WORDS.length;
const DIGIT_MIN = 10;
const DIGIT_RANGE = 90; // 10..99 inclusive

function pickIndex(random: () => number, length: number): number {
  const clamped = Math.min(Math.max(random(), 0), 0.999999999);
  return Math.floor(clamped * length);
}

/** 乱数は注入する(テストで決定的にするため)。random() は [0,1) を返す */
export function generatePassphrase(random: () => number): string {
  const word1 = WORDS[pickIndex(random, WORD_COUNT)] ?? WORDS[0];
  const word2 = WORDS[pickIndex(random, WORD_COUNT)] ?? WORDS[0];
  const digits = DIGIT_MIN + pickIndex(random, DIGIT_RANGE);
  return `${word1}-${word2}-${String(digits).padStart(2, '0')}`;
}

/** @internal exported for tests */
export function getPassphraseWordList(): readonly string[] {
  return WORDS;
}
