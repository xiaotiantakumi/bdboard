import { describe, expect, it } from 'vitest';
import type { Ticket } from '../../domain/ticket.js';
import { deserializeTickets, serializeTickets } from './ticket-serialization.js';

function fullTicket(): Ticket {
  return {
    id: 'proj-abc',
    projectId: 'my-project',
    title: 'Full issue',
    status: 'in_progress',
    priority: 1,
    issueType: 'feature',
    createdAt: new Date('2026-08-14T08:00:00.000Z'),
    updatedAt: new Date('2026-08-14T09:00:00.000Z'),
    dependencies: [
      {
        issueId: 'proj-abc',
        dependsOnId: 'proj-blocker',
        kind: 'blocks',
      },
      {
        issueId: 'proj-abc',
        dependsOnId: 'proj-parent',
        kind: 'parent-child',
      },
    ],
    assignee: 'Assignee',
    owner: 'owner@example.com',
    startedAt: new Date('2026-08-14T08:30:00.000Z'),
    closedAt: new Date('2026-08-14T10:00:00.000Z'),
    deferUntil: new Date('2026-12-31T00:00:00.000Z'),
    parentId: 'proj-parent',
    description: 'desc',
    notes: 'notes',
    commentCount: 3,
  };
}

function minimalTicket(): Ticket {
  return {
    id: 'proj-min',
    projectId: 'my-project',
    title: 'Minimal',
    status: 'open',
    priority: 2,
    issueType: 'task',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    dependencies: [],
    commentCount: 0,
  };
}

describe('ticket serialization', () => {
  it('round-trips a ticket with all fields populated', () => {
    const original = fullTicket();
    const restored = deserializeTickets(serializeTickets([original]))[0];

    expect(restored).toEqual(original);
  });

  it('round-trips a ticket without optional fields and omits undefined keys', () => {
    const original = minimalTicket();
    const json = serializeTickets([original]);
    const parsed = JSON.parse(json) as Record<string, unknown>[];

    expect(parsed[0]).not.toHaveProperty('assignee');
    expect(parsed[0]).not.toHaveProperty('owner');
    expect(parsed[0]).not.toHaveProperty('startedAt');
    expect(parsed[0]).not.toHaveProperty('closedAt');
    expect(parsed[0]).not.toHaveProperty('deferUntil');
    expect(parsed[0]).not.toHaveProperty('parentId');
    expect(parsed[0]).not.toHaveProperty('description');
    expect(parsed[0]).not.toHaveProperty('notes');

    const restored = deserializeTickets(json)[0];
    expect(restored).toEqual(original);
    expect(Object.keys(restored)).not.toContain('assignee');
    expect(Object.keys(restored)).not.toContain('owner');
    expect(Object.keys(restored)).not.toContain('startedAt');
    expect(Object.keys(restored)).not.toContain('closedAt');
    expect(Object.keys(restored)).not.toContain('deferUntil');
    expect(Object.keys(restored)).not.toContain('parentId');
    expect(Object.keys(restored)).not.toContain('description');
    expect(Object.keys(restored)).not.toContain('notes');
  });

  it('round-trips multiple dependencies', () => {
    const original = fullTicket();
    const restored = deserializeTickets(serializeTickets([original]))[0];

    expect(restored?.dependencies).toEqual(original.dependencies);
  });

  it('round-trips an empty ticket array', () => {
    expect(deserializeTickets(serializeTickets([]))).toEqual([]);
  });

  it('defaults commentCount to 0 when absent in stored JSON', () => {
    const json = JSON.stringify([
      {
        id: 'proj-legacy',
        projectId: 'my-project',
        title: 'Legacy',
        status: 'open',
        priority: 2,
        issueType: 'task',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        dependencies: [],
      },
    ]);

    const restored = deserializeTickets(json)[0];
    expect(restored?.commentCount).toBe(0);
  });
});
