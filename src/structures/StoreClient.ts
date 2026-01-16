import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Ref, Schedule, Schema, Scope } from 'effect';

/**
 * Ensures that the directory for a given file path exists.
 *
 * @param path - The file path for which to ensure the directory exists.
 */
const ensureDir = (path: string) => Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));

/**
 * Represents errors occurring within the store client.
 */
export class StoreClientError extends Data.TaggedError('StoreClientError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Interface defining the store client service.
 *
 * @template T - The type of data stored.
 */
export interface StoreClient<T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
}

/**
 * Loads the store from a file, initializing it with default data if it doesn't exist.
 *
 * @template A - The data type to load.
 * @param filePath - The path to the store file.
 * @param initialData - The initial data to use if the file is missing or invalid.
 */
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

/**
 * Saves the store data to a file using an atomic write operation.
 */
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

/**
 * Creates a store client instance with persistence and auto-save capabilities.
 *
 * @template A - The data type stored.
 * @template I - The input type for the schema.
 * @template R - The requirements for the schema.
 * @param filePath - The path to the persistence file.
 * @param schema - The schema for validating the stored data.
 * @param initialData - The initial data for the store.
 * @param initialDelay - The delay in milliseconds between auto-saves.
 */
export const createStore = <A extends object, I, R>(
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
): Effect.Effect<StoreClient<A>, StoreClientError, R | Scope.Scope> =>
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

          return defaultsDeep({}, partial, initialData);
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

/**
 * Factory for creating a store client layer.
 *
 * @template S - The service tag type.
 * @template A - The data type stored in the client.
 * @template I - The input type for the schema.
 * @template R - The requirements for the schema.
 * @param tag - The context tag for the store client.
 * @param filePath - The path to the persistence file.
 * @param schema - The schema for validating the stored data.
 * @param initialData - The initial data for the store.
 * @param initialDelay - The delay in milliseconds between auto-saves.
 * @returns A layer providing the store client.
 */
export const StoreClientLayer = <S, A extends object, I, R>(
  tag: Context.Tag<S, StoreClient<A>>,
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
): Layer.Layer<S, StoreClientError, R> => Layer.scoped(tag, createStore(filePath, schema, initialData, initialDelay));
