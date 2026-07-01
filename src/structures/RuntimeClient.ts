import { chalk } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Cause, Chunk, Data, Effect, Exit, Fiber, Ref, Runtime } from 'effect';

export class RuntimeRestart extends Data.TaggedError('RuntimeRestart') {}

export interface RuntimeBridge {
  readonly runFork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.RuntimeFiber<A, E>;
  readonly runSync: <A, E, R>(effect: Effect.Effect<A, E, R>) => A;
  readonly runPromise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
}

export const makeRuntimeBridge = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<unknown>();
  const runFork = Runtime.runFork(runtime);
  const runSync = Runtime.runSync(runtime);
  const runPromise = Runtime.runPromise(runtime);

  return {
    runFork: (effect) => runFork(effect),
    runSync: (effect) => runSync(effect),
    runPromise: (effect) => runPromise(effect),
  } as RuntimeBridge;
});

export interface RuntimeCycleOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

export const cycleUntilMidnight = Effect.gen(function* () {
  const msUntilMidnight = yield* Effect.sync(() => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return tomorrow.getTime() - now.getTime();
  });

  yield* Effect.sleep(`${msUntilMidnight} millis`);
  yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting system...}`);
  return yield* new RuntimeRestart();
});

export const runMainCycle = <A, E, R>(program: Effect.Effect<A, E, R>, options: RuntimeCycleOptions = {}): void => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;

  const isRuntimeRestart = (error: unknown): error is RuntimeRestart =>
    error instanceof RuntimeRestart || (isObjectLike<{ readonly _tag: string }>(error) && error._tag === 'RuntimeRestart');

  let keepAlive: NodeJS.Timeout | undefined = undefined;
  let isShuttingDown = false;

  const wrappedProgram = Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
      }),
      () =>
        Effect.sync(() => {
          if (!isShuttingDown && !keepAlive) {
            keepAlive = setInterval(() => {}, 60_000);
          }
        }),
    );
    return yield* program;
  });

  const mainCycle = Effect.gen(function* () {
    const restartTimesRef = yield* Ref.make<readonly number[]>([]);

    while (true) {
      const exitValue = yield* Effect.exit(Effect.scoped(wrappedProgram));

      if (Exit.isSuccess(exitValue)) {
        yield* Ref.set(restartTimesRef, []);
        continue;
      }

      const cause = exitValue.cause;
      const restartTriggered = Chunk.some(Cause.failures(cause), isRuntimeRestart);

      if (restartTriggered) {
        yield* Ref.set(restartTimesRef, []);
        continue;
      }

      const now = Date.now();
      const restartTimes = yield* Ref.get(restartTimesRef);
      const nextRestarts = [...restartTimes.filter((t) => now - t < intervalMs), now];
      yield* Ref.set(restartTimesRef, nextRestarts);

      if (nextRestarts.length >= maxRestarts) {
        isShuttingDown = true;
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }

        yield* Effect.logFatal(chalk`{bold.red System crashed too many times. Shutting down...}`, cause);
        yield* Effect.promise(() => process.exit(1));
        return;
      }

      yield* Effect.logError(chalk`{bold.red System encountered an error}`, cause);
      yield* Effect.logInfo(chalk`{bold.yellow Restarting in ${restartDelayMs / 1000}s...}`);
      yield* Effect.sleep(`${restartDelayMs} millis`);
    }
  });

  const mainEffect = Effect.gen(function* () {
    const { runFork, runPromise } = yield* makeRuntimeBridge;

    const fiber = runFork(mainCycle);

    const cleanUp = async () => {
      isShuttingDown = true;
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = undefined;
      }
      return runPromise(Fiber.interrupt(fiber))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    process.once('SIGINT', () => cleanUp());
    process.once('SIGTERM', () => cleanUp());
  });

  Effect.runPromise(mainEffect as Effect.Effect<never, never, never>);
};
