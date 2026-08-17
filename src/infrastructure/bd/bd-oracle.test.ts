import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createReadinessContext,
  isBlocked,
  isReady,
} from '../../domain/readiness.js';
import { mapBdListToTickets } from './bd-issue-mapper.js';

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/bd',
);

function listFixtureProjects(): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.list.json'))
    .map((name) => name.slice(0, -'.list.json'.length))
    .sort();
}

function readJsonFixture<T>(projectName: string, suffix: 'list' | 'blocked' | 'ready'): T {
  const filePath = path.join(fixturesDir, `${projectName}.${suffix}.json`);
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function extractIds(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id).sort();
}

const projects = listFixtureProjects();

describe('bd oracle fixtures', () => {
  it.each(projects)('%s: derived blocked/ready matches bd CLI oracle', (projectName) => {
    const listRaw = readJsonFixture<unknown>(projectName, 'list');
    const blockedOracle = readJsonFixture<readonly { id: string }[]>(projectName, 'blocked');
    const readyOracle = readJsonFixture<readonly { id: string }[]>(projectName, 'ready');

    const { tickets } = mapBdListToTickets(listRaw, projectName);
    const ctx = createReadinessContext(tickets);
    const now = new Date();

    const derivedBlocked = tickets
      .filter((ticket) => isBlocked(ticket, ctx))
      .map((ticket) => ticket.id)
      .sort();

    const derivedReady = tickets
      .filter((ticket) => isReady(ticket, ctx, now))
      .map((ticket) => ticket.id)
      .sort();

    expect(derivedBlocked).toEqual(extractIds(blockedOracle));
    expect(derivedReady).toEqual(extractIds(readyOracle));
  });
});
