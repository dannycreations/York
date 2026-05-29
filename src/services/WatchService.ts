import { Context, Effect, Layer, Option, Ref } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';

import type { TwitchApiError } from '../api/TwitchApi';
import type { Channel } from '../core/Schemas';

export interface WatchService {
  readonly updateChannelInfo: (
    channel: Channel,
    localMinutesWatchedRef: Ref.Ref<number>,
    currentChannelRef: Ref.Ref<Option.Option<Channel>>,
  ) => Effect.Effect<Option.Option<Channel>>;
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
      updateChannelInfo: (chan, localMinutesWatchedRef, currentChannelRef) =>
        Effect.gen(function* () {
          const localMin = yield* Ref.get(localMinutesWatchedRef);

          if (!!chan.currentSid && localMin > 0 && localMin < 15) {
            return Option.some(chan);
          }

          const streamRes = yield* api.helixStreams(chan.id).pipe(Effect.option);
          if (Option.isNone(streamRes)) return Option.none();

          const live = streamRes.value.data[0];
          if (!live) return Option.none();

          const updated: Channel = {
            ...chan,
            currentSid: live.id,
            currentGameId: live.game_id,
            currentGameName: live.game_name,
          };

          yield* Ref.update(currentChannelRef, (current) =>
            Option.match(current, {
              onNone: () => Option.some(updated),
              onSome: (c) => (c.id === updated.id ? Option.some(updated) : current),
            }),
          );

          return Option.some(updated);
        }),

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
