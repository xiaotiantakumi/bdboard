import { describe, expect, it } from 'vitest';
import type { AiQuotaProviderSnapshot } from '../ports/ai-quota-source.js';
import { createAiQuotaThresholdPublisher } from './ai-quota-threshold-alerts.js';

function makeProvider(
  id: string,
  label: string,
  metrics: AiQuotaProviderSnapshot['metrics'],
): AiQuotaProviderSnapshot {
  return { id, label, metrics };
}

describe('createAiQuotaThresholdPublisher', () => {
  it('fires once on first breach below threshold', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const occurredAt = new Date('2026-08-17T10:00:00.000Z');
    const providers = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 15 },
      ]),
    ];

    const payloads = publisher.collectBreaches(providers, 20, occurredAt);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      kind: 'ai_quota_threshold',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      metricLabel: 'Weekly',
      percentRemaining: 15,
      thresholdPercent: 20,
      occurredAt: occurredAt.toISOString(),
    });
  });

  it('does not fire again while still below threshold', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const occurredAt = new Date('2026-08-17T10:00:00.000Z');
    const providers = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 15 },
      ]),
    ];

    publisher.collectBreaches(providers, 20, occurredAt);
    const second = publisher.collectBreaches(providers, 20, new Date('2026-08-17T10:01:00.000Z'));
    expect(second).toHaveLength(0);
  });

  it('fires again after recovery above threshold then breach', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const providers = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 15 },
      ]),
    ];

    publisher.collectBreaches(providers, 20, new Date('2026-08-17T10:00:00.000Z'));

    const recovered = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 25 },
      ]),
    ];
    publisher.collectBreaches(recovered, 20, new Date('2026-08-17T11:00:00.000Z'));

    const breachedAgain = publisher.collectBreaches(providers, 20, new Date('2026-08-17T12:00:00.000Z'));
    expect(breachedAgain).toHaveLength(1);
    expect(breachedAgain[0].percentRemaining).toBe(15);
  });

  it('fires again when occurredAt crosses recorded resetAt while still below threshold', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const resetAt = new Date('2026-08-17T12:00:00.000Z');
    const providers = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 10, resetAt },
      ]),
    ];

    publisher.collectBreaches(providers, 20, new Date('2026-08-17T10:00:00.000Z'));
    const afterReset = publisher.collectBreaches(
      providers,
      20,
      new Date('2026-08-17T12:00:00.000Z'),
    );
    expect(afterReset).toHaveLength(1);
    expect(afterReset[0].resetAt).toBe(resetAt.toISOString());
  });

  it('does not refire without resetAt until recovery', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const providers = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 10 },
      ]),
    ];

    publisher.collectBreaches(providers, 20, new Date('2026-08-17T10:00:00.000Z'));
    const second = publisher.collectBreaches(
      providers,
      20,
      new Date('2026-08-18T10:00:00.000Z'),
    );
    expect(second).toHaveLength(0);
  });

  it('skips metrics without percentRemaining', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const providers = [
      makeProvider('gemini', 'Gemini', [
        { label: 'Quota', status: 'exhausted' },
        { label: 'Weekly', percentRemaining: 5 },
      ]),
    ];

    const payloads = publisher.collectBreaches(
      providers,
      20,
      new Date('2026-08-17T10:00:00.000Z'),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0].metricLabel).toBe('Weekly');
  });

  it('tracks multiple providers and metrics independently', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const occurredAt = new Date('2026-08-17T10:00:00.000Z');
    const providers = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 10 },
        { label: 'Daily', percentRemaining: 5 },
      ]),
      makeProvider('anthropic', 'Anthropic', [
        { label: 'Weekly', percentRemaining: 8 },
      ]),
    ];

    const payloads = publisher.collectBreaches(providers, 20, occurredAt);
    expect(payloads).toHaveLength(3);

    const recoveredOpenAiWeekly = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 50 },
        { label: 'Daily', percentRemaining: 5 },
      ]),
      makeProvider('anthropic', 'Anthropic', [
        { label: 'Weekly', percentRemaining: 8 },
      ]),
    ];
    publisher.collectBreaches(recoveredOpenAiWeekly, 20, new Date('2026-08-17T11:00:00.000Z'));

    const second = publisher.collectBreaches(providers, 20, new Date('2026-08-17T12:00:00.000Z'));
    expect(second).toHaveLength(1);
    expect(second[0].providerId).toBe('openai');
    expect(second[0].metricLabel).toBe('Weekly');
  });

  it('updates resetAtMs when it becomes known without refiring', () => {
    const publisher = createAiQuotaThresholdPublisher();
    const withoutReset = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 10 },
      ]),
    ];
    publisher.collectBreaches(withoutReset, 20, new Date('2026-08-17T10:00:00.000Z'));

    const resetAt = new Date('2026-08-17T14:00:00.000Z');
    const withReset = [
      makeProvider('openai', 'OpenAI', [
        { label: 'Weekly', percentRemaining: 10, resetAt },
      ]),
    ];
    const beforeReset = publisher.collectBreaches(
      withReset,
      20,
      new Date('2026-08-17T11:00:00.000Z'),
    );
    expect(beforeReset).toHaveLength(0);

    const afterReset = publisher.collectBreaches(
      withReset,
      20,
      new Date('2026-08-17T14:00:00.000Z'),
    );
    expect(afterReset).toHaveLength(1);
  });
});
