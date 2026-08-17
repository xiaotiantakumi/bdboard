import type { Link, Root, Text } from 'mdast';
import { describe, expect, it } from 'vitest';
import {
  BEAD_ID_URL_PREFIX,
  remarkBeadIdLinks,
} from './remarkBeadIdLinks';

function paragraphWithText(value: string): Root {
  return {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value }],
      },
    ],
  };
}

function applyPlugin(
  tree: Root,
  isKnownId: (id: string) => boolean,
): Root {
  const plugin = remarkBeadIdLinks(isKnownId);
  plugin(tree);
  return tree;
}

function paragraphChildren(tree: Root) {
  const paragraph = tree.children[0];
  expect(paragraph?.type).toBe('paragraph');
  if (paragraph?.type !== 'paragraph') {
    return [];
  }
  return paragraph.children;
}

describe('remarkBeadIdLinks', () => {
  it('links only known bead IDs', () => {
    const tree = paragraphWithText(
      'See bdboard-abc.1 and bdboard-unknown.9 for context.',
    );
    applyPlugin(tree, (id) => id === 'bdboard-abc.1');

    const children = paragraphChildren(tree);
    expect(children).toHaveLength(3);
    expect(children[0]).toEqual({ type: 'text', value: 'See ' });
    expect(children[1]).toEqual({
      type: 'link',
      url: `${BEAD_ID_URL_PREFIX}bdboard-abc.1`,
      children: [{ type: 'text', value: 'bdboard-abc.1' }],
    });
    expect(children[2]).toEqual({
      type: 'text',
      value: ' and bdboard-unknown.9 for context.',
    });
  });

  it('does not modify text when no bead IDs are present', () => {
    const tree = paragraphWithText('Plain text without ticket references.');
    const before = structuredClone(tree);
    applyPlugin(tree, () => true);

    expect(tree).toEqual(before);
  });

  it('does not link unknown bead ID-like strings', () => {
    const tree = paragraphWithText('Blocked by bdboard-missing.42');
    const before = structuredClone(tree);
    applyPlugin(tree, () => false);

    expect(tree).toEqual(before);
  });

  it('links multiple known IDs in one text node', () => {
    const tree = paragraphWithText('Depends on bdboard-abc.1 and bdboard-419');
    applyPlugin(tree, (id) =>
      ['bdboard-abc.1', 'bdboard-419'].includes(id),
    );

    const children = paragraphChildren(tree);
    expect(children).toHaveLength(4);
    expect(children[0]).toEqual({ type: 'text', value: 'Depends on ' });
    expect((children[1] as Link).url).toBe(`${BEAD_ID_URL_PREFIX}bdboard-abc.1`);
    expect(children[2]).toEqual({ type: 'text', value: ' and ' });
    expect((children[3] as Link).url).toBe(`${BEAD_ID_URL_PREFIX}bdboard-419`);
  });

  it('does not transform text inside existing link nodes', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com',
              children: [{ type: 'text', value: 'see bdboard-abc.1 here' }],
            },
          ],
        },
      ],
    };

    const before = structuredClone(tree);
    applyPlugin(tree, () => true);

    expect(tree).toEqual(before);
  });

  it('matches dotted bead IDs such as bdboard-3tw.64', () => {
    const tree = paragraphWithText('Follow-up in bdboard-3tw.64');
    applyPlugin(tree, (id) => id === 'bdboard-3tw.64');

    const children = paragraphChildren(tree);
    expect(children).toHaveLength(2);
    expect(children[0]).toEqual({ type: 'text', value: 'Follow-up in ' });
    expect((children[1] as Link).children[0]).toEqual({
      type: 'text',
      value: 'bdboard-3tw.64',
    } satisfies Text);
  });
});
