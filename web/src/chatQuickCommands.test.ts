import { describe, expect, it } from 'vitest';
import { CHAT_QUICK_COMMANDS } from './chatQuickCommands';

describe('chatQuickCommands', () => {
  it('defines at least one quick command', () => {
    expect(CHAT_QUICK_COMMANDS.length).toBeGreaterThan(0);
  });

  it('uses unique ids', () => {
    const ids = CHAT_QUICK_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command a non-empty label and prompt', () => {
    for (const command of CHAT_QUICK_COMMANDS) {
      expect(command.label.trim().length).toBeGreaterThan(0);
      expect(command.prompt.trim().length).toBeGreaterThan(0);
    }
  });
});
