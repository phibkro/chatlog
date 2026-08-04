import { Effect } from "effect";
import { RecallError, type RecallClock } from "../src/recall-runtime";

interface FakeWaiter {
  readonly timestamp: number;
  readonly resume: () => void;
  readonly remove: () => void;
}

/** A deterministic clock for tests and semantic simulations. */
export class FakeRecallClock implements RecallClock {
  private current: number;
  private readonly waiters = new Set<FakeWaiter>();

  constructor(startAt = 0) {
    if (!Number.isFinite(startAt))
      throw new RecallError("invalid-request", "fake clock start must be finite");
    this.current = startAt;
  }

  now = (): number => this.current;

  waitUntil = (timestamp: number): Effect.Effect<void> => {
    if (!Number.isFinite(timestamp)) return Effect.void;
    if (timestamp <= this.current) return Effect.void;
    return Effect.callback((resume, signal) => {
      let active = true;
      const waiter: FakeWaiter = {
        timestamp,
        resume: () => {
          if (!active) return;
          active = false;
          this.waiters.delete(waiter);
          resume(Effect.void);
        },
        remove: () => {
          active = false;
          this.waiters.delete(waiter);
        },
      };
      this.waiters.add(waiter);
      const abort = (): void => waiter.remove();
      signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => {
        signal.removeEventListener("abort", abort);
        waiter.remove();
      });
    });
  };

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new RecallError(
        "invalid-request",
        "fake clock advance must be finite and non-negative",
      );
    this.current += milliseconds;
    for (const waiter of this.waiters) {
      if (waiter.timestamp <= this.current) waiter.resume();
    }
  }

  set(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp < this.current)
      throw new RecallError("invalid-request", "fake clock cannot move backwards");
    this.current = timestamp;
    for (const waiter of this.waiters) {
      if (waiter.timestamp <= this.current) waiter.resume();
    }
  }

  pendingWaiters(): number {
    return this.waiters.size;
  }
}
