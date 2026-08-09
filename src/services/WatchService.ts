import { Context, Effect, Layer, Option, Ref } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';

import type { TwitchApiError } from '../api/TwitchApi';
import type { Channel } from '../core/Schemas';

export interface WatchService {
  readonly watch: (
    channel: Channel,
    currentChannelRef: Ref.Ref<Option.Option<Channel>>,
  ) => Effect.Effect<{ success: boolean; hlsUrl?: string }, TwitchApiError>;
}

export class WatchServiceTag extends Context.Tag('@services/WatchService')<WatchServiceTag, WatchService>() {}

export const WatchServiceLayer = Layer.effect(
  WatchServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;

    return {
      watch: (channel, currentChannelRef) =>
        Effect.gen(function* () {
          const result = yield* api.watch(channel);

          if (result.hlsUrl !== channel.hlsUrl) {
            yield* Ref.update(
              currentChannelRef,
              Option.map((c) => (c.id === channel.id ? { ...c, hlsUrl: result.hlsUrl } : c)),
            );
          }

          return result;
        }),
    };
  }),
);
