import { describe, expect, it } from 'vitest';
import { RequestPacer } from '../../src/providers/http.js';

// Small, generous-tolerance real-timer delays (not fake timers): pace() composes setTimeout-based
// sleep() internally, so real timers exercise the actual wait path end to end. 30ms is small enough
// to keep the suite fast, large enough that scheduler jitter on CI can't flip the assertions.
const DELAY_MS = 30;
const DELAY_SECONDS = DELAY_MS / 1000;
const TOLERANCE_MS = 15;

describe('RequestPacer', () => {
  it('never waits on the first call', async () => {
    const pacer = new RequestPacer(DELAY_SECONDS);
    const start = Date.now();
    await pacer.pace();
    expect(Date.now() - start).toBeLessThan(TOLERANCE_MS);
  });

  it('waits the remainder of the delay on a second call that follows immediately', async () => {
    const pacer = new RequestPacer(DELAY_SECONDS);
    await pacer.pace();
    const start = Date.now();
    await pacer.pace();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(DELAY_MS - TOLERANCE_MS);
    expect(elapsed).toBeLessThan(DELAY_MS + 200);
  });

  it('does not wait when the prior call was already slower than the configured delay', async () => {
    const pacer = new RequestPacer(DELAY_SECONDS);
    await pacer.pace();
    // Simulate a slow response: more time passes than the configured delay before the next pace().
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 2));
    const start = Date.now();
    await pacer.pace();
    expect(Date.now() - start).toBeLessThan(TOLERANCE_MS);
  });

  it('is a no-op when delaySeconds is 0 or negative', async () => {
    const pacer = new RequestPacer(0);
    await pacer.pace();
    const start = Date.now();
    await pacer.pace();
    expect(Date.now() - start).toBeLessThan(TOLERANCE_MS);
  });
});
