import { Effect, Option, Ref } from 'effect';

import type { Campaign, Channel, Drop } from './Schemas.js';

export interface MainState {
  readonly currentCampaign: Ref.Ref<Option.Option<Campaign>>;
  readonly currentChannel: Ref.Ref<Option.Option<Channel>>;
  readonly currentDrop: Ref.Ref<Option.Option<Drop>>;
  readonly localMinutesWatched: Ref.Ref<number>;
  readonly nextPointClaim: Ref.Ref<number>;
  readonly nextWatch: Ref.Ref<number>;
  readonly isClaiming: Ref.Ref<boolean>;
}

export const makeMainState: Effect.Effect<MainState> = Effect.gen(function* () {
  return {
    currentCampaign: yield* Ref.make<Option.Option<Campaign>>(Option.none()),
    currentChannel: yield* Ref.make<Option.Option<Channel>>(Option.none()),
    currentDrop: yield* Ref.make<Option.Option<Drop>>(Option.none()),
    localMinutesWatched: yield* Ref.make(0),
    nextPointClaim: yield* Ref.make(0),
    nextWatch: yield* Ref.make(0),
    isClaiming: yield* Ref.make(false),
  } satisfies MainState;
});
