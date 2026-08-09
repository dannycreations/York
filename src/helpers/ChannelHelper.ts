import { Effect, Option, Ref } from 'effect';

import { TwitchSocketTag } from '../api/TwitchSocket';
import { WsTopic } from '../core/Constants';

import type { Channel } from '../core/Schemas';

export const CHANNEL_LISTENER_TOPICS = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;

export const resetChannel = (channelRef: Ref.Ref<Option.Option<Channel>>): Effect.Effect<void, never, TwitchSocketTag> =>
  Effect.gen(function* () {
    const socket = yield* TwitchSocketTag;
    const curOpt = yield* Ref.get(channelRef);

    if (Option.isSome(curOpt)) {
      const chan = curOpt.value;

      yield* Effect.forEach(CHANNEL_LISTENER_TOPICS, (topic) => socket.unlisten(topic, chan.id), {
        concurrency: 'unbounded',
        discard: true,
      }).pipe(Effect.catchAllCause(() => Effect.void));

      yield* Ref.set(channelRef, Option.none());
    }
  });

export const setChannel = (channelRef: Ref.Ref<Option.Option<Channel>>, channel: Channel): Effect.Effect<void, never, TwitchSocketTag> =>
  Effect.gen(function* () {
    const curOpt = yield* Ref.get(channelRef);
    if (Option.isSome(curOpt) && curOpt.value.id === channel.id) {
      return;
    }

    yield* resetChannel(channelRef);
    yield* Ref.set(channelRef, Option.some(channel));
  });
