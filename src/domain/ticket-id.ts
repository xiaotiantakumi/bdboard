export type TicketId = string;

export interface ParsedTicketId {
  prefix: string;
  shortId: string;
}

export class InvalidTicketIdError extends Error {
  constructor(id: string, reason: string) {
    super(`Invalid ticket id "${id}": ${reason}`);
    this.name = 'InvalidTicketIdError';
    Object.setPrototypeOf(this, InvalidTicketIdError.prototype);
  }
}

function validateTicketId(id: string): ParsedTicketId {
  if (id.length === 0) {
    throw new InvalidTicketIdError(id, 'id must not be empty');
  }

  if (/\s/.test(id)) {
    throw new InvalidTicketIdError(id, 'id must not contain whitespace');
  }

  const lastDash = id.lastIndexOf('-');
  if (lastDash === -1) {
    throw new InvalidTicketIdError(id, 'id must contain a dash separator');
  }

  const prefix = id.slice(0, lastDash);
  const shortId = id.slice(lastDash + 1);

  if (prefix.length === 0) {
    throw new InvalidTicketIdError(id, 'prefix must not be empty');
  }

  if (shortId.length === 0) {
    throw new InvalidTicketIdError(id, 'shortId must not be empty');
  }

  const segments = shortId.split('.');
  if (segments.some((segment) => segment.length === 0)) {
    throw new InvalidTicketIdError(
      id,
      'shortId must not contain empty dot-separated segments',
    );
  }

  return { prefix, shortId };
}

export function parseTicketId(id: string): ParsedTicketId {
  return validateTicketId(id);
}

export function isTicketId(value: string): boolean {
  try {
    validateTicketId(value);
    return true;
  } catch {
    return false;
  }
}

export function parentTicketId(id: TicketId): TicketId | null {
  const { prefix, shortId } = validateTicketId(id);
  const lastDot = shortId.lastIndexOf('.');

  if (lastDot === -1) {
    return null;
  }

  return `${prefix}-${shortId.slice(0, lastDot)}`;
}

export function rootTicketId(id: TicketId): TicketId {
  const { prefix, shortId } = validateTicketId(id);
  const dot = shortId.indexOf('.');
  const root = dot === -1 ? shortId : shortId.slice(0, dot);

  return `${prefix}-${root}`;
}

export function ticketIdDepth(id: TicketId): number {
  const { shortId } = validateTicketId(id);
  const dotCount = shortId.split('.').length - 1;

  return dotCount;
}
