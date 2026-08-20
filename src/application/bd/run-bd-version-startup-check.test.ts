import { describe, expect, it, vi } from 'vitest';
import { EXPECTED_BD_VERSION } from '../../domain/bd-version-check.js';
import { runBdVersionStartupCheck } from './run-bd-version-startup-check.js';

function createLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
  };
}

describe('runBdVersionStartupCheck', () => {
  it('logs a confirmation when the installed version matches', async () => {
    const logger = createLogger();

    await runBdVersionStartupCheck(async () => EXPECTED_BD_VERSION, logger);

    expect(logger.log).toHaveBeenCalledWith(
      `bd CLI version matches expected ${EXPECTED_BD_VERSION}.`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when the installed version differs', async () => {
    const logger = createLogger();

    await runBdVersionStartupCheck(async () => '1.2.2', logger);

    expect(logger.warn).toHaveBeenCalledWith(
      `bd CLI version mismatch: expected ${EXPECTED_BD_VERSION}, found 1.2.2. See README for why ${EXPECTED_BD_VERSION} is pinned (bd-m7zzd regression).`,
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('remains silent when the version is unavailable', async () => {
    const logger = createLogger();

    await runBdVersionStartupCheck(async () => null, logger);

    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('continues when version reading unexpectedly throws', async () => {
    const logger = createLogger();

    await expect(
      runBdVersionStartupCheck(async () => {
        throw new Error('unexpected failure');
      }, logger),
    ).resolves.toBeUndefined();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
