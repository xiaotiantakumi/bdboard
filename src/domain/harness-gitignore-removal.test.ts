import { describe, expect, it } from 'vitest';
import { removeGitignoreEntries } from './harness-gitignore-removal.js';
import { appendGitignoreEntries } from './harness-path.js';

const HEADER = '# bdboard-harness: managed pack injections (do not edit lines below by hand)';

describe('removeGitignoreEntries', () => {
  it('undoes appendGitignoreEntries except for the shared header and settings.local.json line', () => {
    const original = 'node_modules\ndist/\n';
    const injected = appendGitignoreEntries(original, 'base-pack');

    const removed = removeGitignoreEntries(injected, 'base-pack', { removeManifestEntry: true });

    expect(removed).toBe(
      `${original}# bdboard-harness: managed pack injections (do not edit lines below by hand)\n.claude/settings.local.json\n`,
    );
  });

  it('never removes the settings.local.json line, even for the last pack', () => {
    const injected = appendGitignoreEntries('', 'base-pack');
    expect(removeGitignoreEntries(injected, 'base-pack', { removeManifestEntry: true })).toContain(
      '.claude/settings.local.json',
    );
  });

  it('keeps the manifest line while other packs remain', () => {
    const injected = appendGitignoreEntries(appendGitignoreEntries('', 'a'), 'b');
    const removed = removeGitignoreEntries(injected, 'b', { removeManifestEntry: false });
    expect(removed).toContain('.claude/bdboard-packs.json');
    expect(removed).toContain('.claude/skills/a/');
    expect(removed).not.toContain('.claude/skills/b/');
  });

  it('matches whole lines only (a longer path that merely contains the entry is not touched)', () => {
    const content = `${HEADER}\n.claude/skills/base-pack/\n.claude/skills/base-pack-extra/\nfoo/.claude/skills/base-pack/\n`;
    expect(removeGitignoreEntries(content, 'base-pack', { removeManifestEntry: false })).toBe(
      `${HEADER}\n.claude/skills/base-pack-extra/\nfoo/.claude/skills/base-pack/\n`,
    );
  });

  it('only touches lines after the managed header (the user own identical lines before it stay)', () => {
    const content = `.claude/skills/base-pack/\n.claude/bdboard-packs.json\n${HEADER}\n.claude/bdboard-packs.json\n.claude/skills/base-pack/\n`;
    expect(removeGitignoreEntries(content, 'base-pack', { removeManifestEntry: true })).toBe(
      `.claude/skills/base-pack/\n.claude/bdboard-packs.json\n${HEADER}\n`,
    );
  });

  it('does nothing without the managed header (no managed lines exist)', () => {
    const content = '.claude/skills/base-pack/\n';
    expect(removeGitignoreEntries(content, 'base-pack', { removeManifestEntry: true })).toBe(content);
  });

  it('returns the input unchanged when there is nothing to remove', () => {
    const content = 'node_modules\n';
    expect(removeGitignoreEntries(content, 'base-pack', { removeManifestEntry: true })).toBe(content);
  });

  it('ignores an unsafe pack name instead of throwing', () => {
    expect(removeGitignoreEntries('x\n', '../evil', { removeManifestEntry: false })).toBe('x\n');
  });
});
