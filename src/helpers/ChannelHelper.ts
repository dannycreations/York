import { Effect, Option, Ref } from 'effect';

import { TwitchSocketTag } from '../api/TwitchSocket.js';
import { WsTopic } from '../core/Constants.js';

import type { Channel } from '../core/Schemas.js';

export const CHANNEL_LISTENER_TOPICS = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;

export const resetChannel = (channelRef: Ref.Ref<Option.Option<Channel>>): Effect.Effect<void, never, TwitchSocketTag> =>
  Effect.gen(function* () {
    const curOpt = yield* Ref.get(channelRef);

    if (Option.isNone(curOpt)) {
      return;
    }

    const socket = yield* TwitchSocketTag;
    yield* socket.unlisten(CHANNEL_LISTENER_TOPICS, curOpt.value.id).pipe(Effect.catchAllCause(() => Effect.void));
    yield* Ref.set(channelRef, Option.none());
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
