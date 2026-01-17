import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Ref, Schedule, Schema } from 'effect';

const ensureDir = (path: string) => Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));

export class StoreClientError extends Data.TaggedError('StoreClientError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface StoreClient<T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
}

const loadStore = (filePath: string) =>
  Effect.tryPromise(() => readFile(filePath, 'utf-8')).pipe(
    Effect.flatMap((content) => Effect.sync(() => parseJsonc<unknown>(content))),
    Effect.catchAll((error) => {
      if (isErrorLike<{ code: string }>(error) && error.code === 'ENOENT') {
        return Effect.succeed({});
      }
      return Effect.fail(new StoreClientError({ message: `Failed to load store: ${filePath}`, cause: error }));
    }),
  );

const saveStore = <A, I, R>(filePath: string, schema: Schema.Schema<A, I, R>, data: A) =>
  Effect.gen(function* () {
    yield* ensureDir(filePath);

    const encode = Schema.encode(schema);
    const encoded = yield* encode(data).pipe(
      Effect.mapError((error) => new StoreClientError({ message: `Failed to encode store: ${filePath}`, cause: error })),
    );

    const tempPath = `${filePath}.tmp`;
    const content = JSON.stringify(encoded);

    yield* Effect.tryPromise(() => writeFile(tempPath, content));
    yield* Effect.tryPromise(() => rename(tempPath, filePath));
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StoreClientError
        ? error
        : new StoreClientError({
            message: `Failed to save store: ${filePath}`,
            cause: error,
          }),
    ),
  );

export const createStore = <A extends object, I, R>(filePath: string, schema: Schema.Schema<A, I, R>, initialData: A, initialDelay: number = 1000) =>
  Effect.gen(function* () {
    const dataRef = yield* Ref.make(initialData);
    const delayRef = yield* Ref.make(initialDelay);
    const dirtyRef = yield* Ref.make(false);

    const decode = Schema.decodeUnknown(schema);

    const rawData = yield* loadStore(filePath);
    const validatedData = yield* decode(rawData).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`Store validation failed for ${filePath}, attempting to merge with defaults`);
          yield* Effect.logDebug(error);

          const partialDecode = Schema.decodeUnknown(Schema.partial(schema));
          const partial = yield* partialDecode(rawData).pipe(Effect.catchAll(() => Effect.succeed({})));

          return defaultsDeep({}, partial, initialData) as A;
        }),
      ),
    );

    yield* Ref.set(dataRef, validatedData);

    const save = Ref.getAndSet(dirtyRef, false).pipe(
      Effect.flatMap((isDirty) =>
        isDirty
          ? Ref.get(dataRef).pipe(
              Effect.flatMap((data) => saveStore(filePath, schema, data)),
              Effect.catchAll((error) => Effect.zipRight(Ref.set(dirtyRef, true), Effect.logError(`Store auto-save failed for ${filePath}`, error))),
            )
          : Effect.void,
      ),
    );

    const autoSaveLoop = Effect.gen(function* () {
      const delay = yield* Ref.get(delayRef);
      yield* Effect.sleep(`${Math.max(1000, delay)} millis`);
      yield* save;
    }).pipe(Effect.repeat(Schedule.forever));

    yield* Effect.fork(autoSaveLoop);

    yield* Effect.addFinalizer(() => save.pipe(Effect.catchAllCause(() => Effect.void)));

    const client: StoreClient<A> = {
      get: Ref.get(dataRef),
      set: (partial: Partial<A>) => Ref.update(dataRef, (current) => ({ ...current, ...partial })).pipe(Effect.zipRight(Ref.set(dirtyRef, true))),
      update: (f: (data: A) => A) => Ref.update(dataRef, f).pipe(Effect.zipRight(Ref.set(dirtyRef, true))),
      setDelay: (delayMs: number) => Ref.set(delayRef, Math.max(1000, delayMs)),
    };

    return client;
  });

export const StoreClientLayer = <S, A extends object, I, R>(
  tag: Context.Tag<S, StoreClient<A>>,
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
) => Layer.scoped(tag, createStore(filePath, schema, initialData, initialDelay));
