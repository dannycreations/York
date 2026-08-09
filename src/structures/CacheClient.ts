import { Effect, Option, Ref } from 'effect';

interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export interface CachePartition<K, V> {
  readonly hits: ReadonlyMap<K, V>;
  readonly misses: ReadonlyArray<K>;
}

export interface TtlCache<K, V> {
  readonly get: (key: K) => Effect.Effect<Option.Option<V>>;
  readonly partition: (keys: Iterable<K>) => Effect.Effect<CachePartition<K, V>>;
  readonly set: (key: K, value: V) => Effect.Effect<void>;
  readonly setAll: (entries: Iterable<readonly [K, V]>) => Effect.Effect<void>;
  readonly invalidate: (key: K) => Effect.Effect<void>;
  readonly invalidateAll: Effect.Effect<void>;
}

const evict = <K, V>(store: Map<K, CacheEntry<V>>, capacity: number, now: number): void => {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }

  let overflow = store.size - capacity;
  if (overflow <= 0) {
    return;
  }

  for (const key of store.keys()) {
    if (overflow <= 0) {
      break;
    }

    store.delete(key);
    overflow -= 1;
  }
};

export const makeTtlCache = <K, V>(ttlMs: number, capacity = 256): Effect.Effect<TtlCache<K, V>> =>
  Effect.map(Ref.make<ReadonlyMap<K, CacheEntry<V>>>(new Map()), (storeRef) => {
    const write = (entries: Iterable<readonly [K, V]>): Effect.Effect<void> =>
      Ref.update(storeRef, (current) => {
        const now = Date.now();
        const next = new Map(current);

        for (const [key, value] of entries) {
          next.set(key, { value, expiresAt: now + ttlMs });
        }

        evict(next, capacity, now);
        return next;
      });

    return {
      get: (key) =>
        Ref.get(storeRef).pipe(
          Effect.map((store) => {
            const entry = store.get(key);

            if (!entry || entry.expiresAt <= Date.now()) {
              return Option.none<V>();
            }

            return Option.some(entry.value);
          }),
        ),
      partition: (keys) =>
        Ref.get(storeRef).pipe(
          Effect.map((store) => {
            const now = Date.now();
            const hits = new Map<K, V>();
            const misses: K[] = [];
            const seen = new Set<K>();

            for (const key of keys) {
              if (seen.has(key)) {
                continue;
              }

              seen.add(key);
              const entry = store.get(key);

              if (entry && entry.expiresAt > now) {
                hits.set(key, entry.value);
                continue;
              }

              misses.push(key);
            }

            return { hits, misses } satisfies CachePartition<K, V>;
          }),
        ),
      set: (key, value) => write([[key, value]]),
      setAll: write,
      invalidate: (key) =>
        Ref.update(storeRef, (current) => {
          if (!current.has(key)) {
            return current;
          }

          const next = new Map(current);
          next.delete(key);
          return next;
        }),
      invalidateAll: Ref.set(storeRef, new Map()),
    } satisfies TtlCache<K, V>;
  });
