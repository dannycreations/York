import { chalk } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Data, Effect, Fiber, Schedule, Scope } from 'effect';

/**
 * Error indicating a scheduled application restart.
 */
export class RuntimeRestart extends Data.TaggedError('RuntimeRestart') {}

/**
 * Configuration options for the runtime lifecycle.
 */
export interface RuntimeOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

/**
 * Executes an effect in a fiber and ensures graceful cleanup on termination signals.
 *
 * @param effect - The effect to execute.
 */
export const runForkWithCleanUp = <A, E>(effect: Effect.Effect<A, E>) => {
  const fiber = Effect.runFork(
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          Effect.logFatal('Fatal error in background process', cause);
          process.exit(1);
        }),
      ),
    ),
  );
  process.on('SIGINT', () => {
    Effect.runPromise(Fiber.interrupt(fiber))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    Effect.runPromise(Fiber.interrupt(fiber))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
};

/**
 * Executes a program in a loop, automatically restarting it on failure with a delay.
 *
 * @param program - The effect to execute repeatedly.
 * @param options - Configuration for restart behavior.
 */
export const cycleWithRestart = <A, E, R>(program: Effect.Effect<A, E, R | Scope.Scope>, options: RuntimeOptions = {}) => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;
  const restartTimes: number[] = [];

  const loop = Effect.catchAllCause(Effect.scoped(program), (cause) =>
    Effect.gen(function* () {
      const failures = Array.from(Cause.failures(cause));

      // Identification of scheduled restarts or transient network failures allows the system to bypass fatal crash thresholds and maintain availability.
      if (failures.some((error) => isErrorLike<{ _tag: string }>(error) && error._tag === 'RuntimeRestart')) {
        return;
      }

      const now = Date.now();
      const recentRestarts = restartTimes.filter((t) => now - t < intervalMs);
      recentRestarts.push(now);

      restartTimes.length = 0;
      restartTimes.push(...recentRestarts);

      if (restartTimes.length >= maxRestarts) {
        yield* Effect.logFatal(chalk`{bold.red System crashed too many times (${maxRestarts}+ in ${intervalMs / 1000}s). Shutting down...}`, cause);
        process.exit(1);
      }

      yield* Effect.logError(chalk`{bold.red System encountered an error}`, cause);
      yield* Effect.logInfo(chalk`{bold.yellow System restarting in ${restartDelayMs / 1000} seconds...}`);
      yield* Effect.sleep(`${restartDelayMs} millis`);
    }),
  );

  return Effect.repeat(loop, Schedule.forever).pipe(Effect.asVoid);
};

/**
 * Effect that schedules a restart at the next midnight.
 */
export const cycleMidnightRestart = Effect.gen(function* () {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  yield* Effect.sleep(`${msUntilMidnight} millis`);
  yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`);
  return yield* Effect.fail(new RuntimeRestart());
});
