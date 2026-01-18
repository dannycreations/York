import { chalk } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Data, Effect, Fiber, Layer, Runtime, Schedule, Scope } from 'effect';

export class RuntimeRestart extends Data.TaggedError('RuntimeRestart') {}

export interface RuntimeRestartOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

export interface RuntimeOptions<ROut = unknown, E = unknown, RIn = unknown> extends RuntimeRestartOptions {
  readonly runtimeBaseLayer?: Layer.Layer<ROut, E, RIn>;
}

export const runForkWithCleanUp = <A, E, R>(effect: Effect.Effect<A, E, R>, runtime: Runtime.Runtime<R>): void => {
  const runFork = Runtime.runFork(runtime);
  const runPromise = Runtime.runPromise(runtime);

  const fiber = runFork(
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logFatal('Fatal error in background process', cause);
          process.exit(1);
        }),
      ),
    ),
  );

  const cleanUp = () => {
    runPromise(Fiber.interrupt(fiber))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', cleanUp);
  process.on('SIGTERM', cleanUp);
};

export const cycleWithRestart = <A, E, R>(
  program: Effect.Effect<A, E, R | Scope.Scope>,
  options: RuntimeRestartOptions = {},
): Effect.Effect<void, never, R> => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;
  const restartTimes: number[] = [];

  const loop = Effect.catchAllCause(Effect.scoped(program), (cause) =>
    Effect.gen(function* () {
      const failures = Array.from(Cause.failures(cause));

      if (failures.some((error) => isErrorLike<{ readonly _tag: string }>(error) && error._tag === 'RuntimeRestart')) {
        return;
      }

      const now = Date.now();
      const recentRestarts = [...restartTimes.filter((t) => now - t < intervalMs), now];

      restartTimes.length = 0;
      restartTimes.push(...recentRestarts);

      if (restartTimes.length >= maxRestarts) {
        yield* Effect.logFatal(chalk`{bold.red System crashed too many times. Shutting down...}`, cause);
        yield* Effect.sync(() => process.exit(1));
      }

      yield* Effect.logError(chalk`{bold.red System encountered an error}`, cause);
      yield* Effect.logInfo(chalk`{bold.yellow System restarting in ${restartDelayMs / 1000} seconds...}`);
      yield* Effect.sleep(`${restartDelayMs} millis`);
    }),
  );

  return Effect.repeat(loop, Schedule.forever).pipe(Effect.asVoid);
};

export const cycleMidnightRestart: Effect.Effect<never, RuntimeRestart> = Effect.gen(function* () {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  yield* Effect.sleep(`${msUntilMidnight} millis`);
  yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`);
  return yield* Effect.fail(new RuntimeRestart());
});

export const runMain = async <A, E, R, ROut = unknown, RE = unknown, RIn = unknown>(
  program: Effect.Effect<A, E, R | Scope.Scope>,
  options: RuntimeOptions<ROut, RE, RIn> = {},
): Promise<void> => {
  const { runtimeBaseLayer, ...restartOptions } = options;

  const runtimeEffect = runtimeBaseLayer ? Effect.runtime<ROut>().pipe(Effect.provide(runtimeBaseLayer)) : Effect.runtime();
  const runtime = await Effect.runPromise(runtimeEffect as Effect.Effect<Runtime.Runtime<R>>);
  runForkWithCleanUp(cycleWithRestart(program, restartOptions), runtime);
};
