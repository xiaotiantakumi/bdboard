import type { Link, Parent, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

export const BEAD_ID_URL_PREFIX = 'bead-id:';

const BEAD_ID_PATTERN =
  /\b[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\b/g;

type IsKnownId = (id: string) => boolean;

function splitTextNode(
  node: Text,
  isKnownId: IsKnownId,
): Array<Text | Link> | null {
  const value = node.value;
  BEAD_ID_PATTERN.lastIndex = 0;

  if (!BEAD_ID_PATTERN.test(value)) {
    BEAD_ID_PATTERN.lastIndex = 0;
    return null;
  }
  BEAD_ID_PATTERN.lastIndex = 0;

  const replacements: Array<Text | Link> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BEAD_ID_PATTERN.exec(value)) !== null) {
    const id = match[0];
    if (!isKnownId(id)) {
      continue;
    }

    const start = match.index;
    if (start > lastIndex) {
      replacements.push({
        type: 'text',
        value: value.slice(lastIndex, start),
      });
    }

    replacements.push({
      type: 'link',
      url: `${BEAD_ID_URL_PREFIX}${id}`,
      children: [{ type: 'text', value: id }],
    });

    lastIndex = start + id.length;
  }

  if (lastIndex < value.length) {
    replacements.push({
      type: 'text',
      value: value.slice(lastIndex),
    });
  }

  if (replacements.length === 0) {
    return null;
  }

  if (
    replacements.length === 1 &&
    replacements[0]?.type === 'text' &&
    replacements[0].value === value
  ) {
    return null;
  }

  return replacements;
}

export function remarkBeadIdLinks(isKnownId: IsKnownId) {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined) {
        return;
      }

      if (parent.type === 'link' || parent.type === 'linkReference') {
        return;
      }

      const replacements = splitTextNode(node, isKnownId);
      if (replacements === null) {
        return;
      }

      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}
