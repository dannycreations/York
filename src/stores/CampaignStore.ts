import { truncate } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { ChannelDropsSchema } from '../core/Schemas';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { TwitchApiTag } from '../services/TwitchApi';
import { GqlQueries } from '../services/TwitchQueries';
import { TwitchSocketTag } from '../services/TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop, Reward } from '../core/Schemas';
import type { TwitchApi, TwitchApiError } from '../services/TwitchApi';
import type { TwitchSocket, TwitchSocketError } from '../services/TwitchSocket';

export type CampaignStoreState = Data.TaggedEnum<{
  Initial: {};
  PriorityOnly: {};
  All: {};
}>;

export const CampaignStoreState = Data.taggedEnum<CampaignStoreState>();

const REWARD_EXPIRED_MS = 2_592_000_000;

interface RawDrop {
  readonly id: string;
  readonly name: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly requiredMinutesWatched: number;
  readonly requiredSubs?: number | undefined;
  readonly benefitEdges: ReadonlyArray<{
    readonly benefit: {
      readonly id: string;
      readonly name?: string | undefined;
    };
  }>;
  readonly self?:
    | {
        readonly isClaimed: boolean;
        readonly hasPreconditionsMet: boolean;
        readonly currentMinutesWatched: number;
        readonly dropInstanceID: string | null;
      }
    | undefined;
}

const processDrop = (
  drop: RawDrop,
  campaignId: string,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
  allowUpcomingIfHasAward: boolean,
): Option.Option<Drop> => {
  const { startAt, endAt, requiredMinutesWatched, requiredSubs } = drop;
  const subsCount = requiredSubs ?? 0;
  const isClaimed = subsCount > 0 || (drop.self?.isClaimed ?? false);

  if (isClaimed) return Option.none();

  const benefits = drop.benefitEdges.map((e) => e.benefit.id);
  for (const benefitId of benefits) {
    const lastAwardedAt = rewardsMap.get(benefitId);
    if (lastAwardedAt !== undefined && lastAwardedAt >= startAt) {
      return Option.none();
    }
  }

  const currentMinutes = drop.self?.currentMinutesWatched ?? 0;
  const isWatched = drop.self ? isMinutesWatchedMet({ ...drop.self, requiredMinutesWatched }) : false;

  if (isWatched && !config.isClaimDrops) return Option.none();

  const minutesLeft = requiredMinutesWatched - currentMinutes;
  const status = getDropStatus(startAt, endAt, now, minutesLeft);
  const hasAward = !!drop.self?.dropInstanceID;

  if (status.isExpired || (status.isUpcoming && (!allowUpcomingIfHasAward || !hasAward))) {
    return Option.none();
  }

  return Option.some({
    id: drop.id,
    name: truncate((drop.benefitEdges[0]?.benefit.name || drop.name).trim()),
    benefits,
    campaignId,
    startAt,
    endAt,
    requiredMinutesWatched,
    requiredSubs: subsCount > 0 ? subsCount : undefined,
    isClaimed,
    hasPreconditionsMet: drop.self?.hasPreconditionsMet ?? true,
    currentMinutesWatched: currentMinutes,
    dropInstanceID: drop.self?.dropInstanceID || undefined,
  } satisfies Drop);
};

export interface CampaignStore {
  readonly campaigns: Ref.Ref<ReadonlyMap<string, Campaign>>;
  readonly progress: Ref.Ref<ReadonlyArray<Drop>>;
  readonly rewards: Ref.Ref<ReadonlyMap<string, Date>>;
  readonly state: Ref.Ref<CampaignStoreState>;
  readonly updateCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly updateProgress: Effect.Effect<void, TwitchApiError>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getOffline: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
  readonly setPriority: (id: string, priority: number) => Effect.Effect<void>;
  readonly getDropsForCampaign: (campaignId: string) => Effect.Effect<ReadonlyArray<Drop>, TwitchApiError>;
  readonly getChannelsForCampaign: (campaign: Campaign) => Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError>;
  readonly addRewards: (rewards: ReadonlyArray<Reward>) => Effect.Effect<void>;
}

export class CampaignStoreTag extends Context.Tag('@services/CampaignStore')<CampaignStoreTag, CampaignStore>() {}

const filterChannelsByCampaign = (
  api: TwitchApi,
  channels: readonly Channel[],
  campaignId: string,
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> => {
  if (channels.length === 0) return Effect.succeed([]);

  return api
    .graphql(
      channels.map((c) => GqlQueries.channelDrops(c.id)),
      ChannelDropsSchema,
    )
    .pipe(
      Effect.map((responses) => channels.filter((_, i) => responses[i].channel.viewerDropCampaigns?.some((vc) => vc.id === campaignId) ?? false)),
    );
};

const cleanupSocketListeners = (socket: TwitchSocket | undefined, channels: readonly Channel[]): Effect.Effect<void, TwitchSocketError> => {
  if (!socket || channels.length === 0) return Effect.void;

  return Effect.forEach(
    channels,
    (c) =>
      Effect.all(
        [socket.unlisten(WsTopic.ChannelStream, c.id), socket.unlisten(WsTopic.ChannelMoment, c.id), socket.unlisten(WsTopic.ChannelUpdate, c.id)],
        { discard: true },
      ),
    { discard: true },
  );
};

const processOnlineChannels = (
  api: TwitchApi,
  socket: TwitchSocket | undefined,
  campaignId: string,
  channels: readonly Channel[],
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError> =>
  Effect.gen(function* () {
    const filtered = yield* filterChannelsByCampaign(api, channels, campaignId);
    const filteredIds = new Set(filtered.map((f) => f.id));
    yield* cleanupSocketListeners(
      socket,
      channels.filter((oc) => !filteredIds.has(oc.id)),
    );
    return filtered;
  });

const processInventoryDrops = (
  campaigns: ReadonlyArray<{
    readonly id: string;
    readonly timeBasedDrops: ReadonlyArray<RawDrop>;
  }>,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
): ReadonlyArray<Drop> => {
  const result: Drop[] = [];
  for (const campaign of campaigns) {
    const drops = [...campaign.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);
    const filtered: Drop[] = [];
    for (const d of drops) {
      const opt = processDrop(d, campaign.id, config, rewardsMap, now, true);
      if (Option.isSome(opt)) filtered.push(opt.value);
    }

    const len = filtered.length;
    for (let i = 0; i < len; i++) {
      const drop = filtered[i];
      result.push({
        ...drop,
        name: truncate(`${i + 1}/${len}, ${drop.name}`),
      });
    }
  }
  return result;
};

export const CampaignStoreLayer: Layer.Layer<CampaignStoreTag, never, TwitchApiTag | ConfigStoreTag | TwitchSocketTag> = Layer.effect(
  CampaignStoreTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const socket = yield* Effect.serviceOption(TwitchSocketTag).pipe(Effect.map(Option.getOrUndefined));
    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyMap<string, Date>>(new Map());
    const stateRef = yield* Ref.make<CampaignStoreState>(CampaignStoreState.Initial());

    const updateCampaigns: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const [response, existingCampaigns, config] = yield* Effect.all([api.dropsDashboard, Ref.get(campaignsRef), configStore.get]);

      const newCampaignsList = yield* Effect.forEach(
        response.currentUser.dropCampaigns,
        (data) =>
          Effect.gen(function* () {
            const gameName = data.game.displayName;
            if (config.exclusionList.has(gameName)) return Option.none();

            if (config.usePriorityConnected && data.self.isAccountConnected && !config.priorityList.has(gameName)) {
              yield* configStore.update((c) => ({
                ...c,
                priorityList: new Set([...c.priorityList, gameName]),
              }));
            }

            if (config.isPriorityOnly && !config.priorityList.has(gameName)) return Option.none();

            const existing = existingCampaigns.get(data.id);
            return Option.some({
              id: data.id,
              name: truncate((existing?.name || data.name).trim()),
              game: existing?.game || data.game,
              startAt: data.startAt,
              endAt: data.endAt,
              isAccountConnected: data.self.isAccountConnected,
              priority: existing?.priority ?? 0,
              isOffline: existing?.isOffline ?? false,
              allowChannels: existing?.allowChannels ?? [],
            } satisfies Campaign);
          }),
        { concurrency: 10 },
      );

      const campaignMap = new Map<string, Campaign>();
      let changed = false;
      for (const opt of newCampaignsList) {
        if (Option.isSome(opt)) {
          const campaign = opt.value;
          campaignMap.set(campaign.id, campaign);
          if (!changed) {
            const existing = existingCampaigns.get(campaign.id);
            if (!existing || existing.isOffline !== campaign.isOffline || existing.priority !== campaign.priority) {
              changed = true;
            }
          }
        }
      }

      if (changed || campaignMap.size !== existingCampaigns.size) {
        yield* Ref.set(campaignsRef, campaignMap);
      }
    });

    const updateProgress: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.inventory;

      const now = Date.now();
      const rewardsMap = new Map<string, Date>();
      for (const drop of response.currentUser.inventory.gameEventDrops) {
        if (now - drop.lastAwardedAt.getTime() < REWARD_EXPIRED_MS) {
          rewardsMap.set(drop.id, drop.lastAwardedAt);
        }
      }

      const newProgress = processInventoryDrops(response.currentUser.inventory.dropCampaignsInProgress, config, rewardsMap, now);

      yield* Ref.set(rewardsRef, rewardsMap);
      yield* Ref.update(progressRef, (current) => {
        if (newProgress.length === 0) return current;
        if (current.length === 0) return newProgress;

        const currentMap = new Map(current.map((d) => [d.id, d]));
        let changed = false;
        for (const drop of newProgress) {
          const existing = currentMap.get(drop.id);
          if (!existing || existing.currentMinutesWatched !== drop.currentMinutesWatched || existing.isClaimed !== drop.isClaimed) {
            currentMap.set(drop.id, drop);
            changed = true;
          }
        }
        if (!changed) return current;
        return Array.from(currentMap.values());
      });
    });

    const getDropsForCampaign = (campaignId: string): Effect.Effect<ReadonlyArray<Drop>, TwitchApiError> =>
      Effect.gen(function* () {
        const detailRes = yield* api.campaignDetails(campaignId);
        const dropDetail = detailRes.user?.dropCampaign;
        if (!dropDetail) {
          yield* Ref.update(campaignsRef, (map) => {
            const next = new Map(map);
            next.delete(campaignId);
            return next;
          });
          return [];
        }

        yield* Ref.update(campaignsRef, (map) => {
          const next = new Map(map);
          const existing = next.get(campaignId);
          if (existing) {
            next.set(campaignId, {
              ...existing,
              name: truncate(dropDetail.name.trim()),
              game: dropDetail.game,
              allowChannels: dropDetail.allow?.channels?.map((c) => c.name) ?? [],
            });
          }
          return next;
        });

        if (!dropDetail.timeBasedDrops) return [];

        const rewardsMap = yield* Ref.get(rewardsRef);
        const sortedDrops = [...dropDetail.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);

        const config = yield* configStore.get;
        const now = Date.now();
        const activeDrops: Drop[] = [];
        for (const d of sortedDrops) {
          const opt = processDrop(d, campaignId, config, rewardsMap, now, false);
          if (Option.isSome(opt)) activeDrops.push(opt.value);
        }

        const len = activeDrops.length;
        const result = activeDrops.map((drop, i) => ({
          ...drop,
          name: truncate(`${i + 1}/${len}, ${drop.name}`),
        }));

        yield* Ref.update(progressRef, (current) => {
          if (result.length === 0) return current;
          if (current.length === 0) return result;

          const currentMap = new Map(current.map((d) => [d.id, d]));
          let changed = false;
          for (const drop of result) {
            const existing = currentMap.get(drop.id);
            if (!existing || existing.currentMinutesWatched !== drop.currentMinutesWatched || existing.isClaimed !== drop.isClaimed) {
              currentMap.set(drop.id, drop);
              changed = true;
            }
          }
          if (!changed) return current;
          return Array.from(currentMap.values());
        });

        return result;
      });

    const getSortedActive: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const currentState = yield* Ref.get(stateRef);
      const config = yield* configStore.get;
      const now = Date.now();

      const campaigns = yield* Ref.get(campaignsRef);
      const result: Campaign[] = [];
      const seenGames = new Set<string>();

      for (const c of campaigns.values()) {
        if (c.isOffline) continue;
        if (getDropStatus(c.startAt, c.endAt, now).isExpired) continue;
        if (currentState._tag === 'PriorityOnly' && !config.priorityList.has(c.game.displayName)) continue;
        if (seenGames.has(c.game.id)) continue;

        seenGames.add(c.game.id);
        result.push(c);
      }

      return result.sort((a, b) => b.priority - a.priority || a.endAt.getTime() - b.endAt.getTime());
    });

    const getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      const now = Date.now();
      const result: Campaign[] = [];

      for (const c of map.values()) {
        if (getDropStatus(c.startAt, c.endAt, now).isUpcoming) {
          result.push(c);
        }
      }

      return result.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    });

    const getOffline: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      const result: Campaign[] = [];
      for (const c of map.values()) {
        if (c.isOffline) result.push(c);
      }
      return result;
    });

    const setOffline = (id: string, isOffline: boolean): Effect.Effect<void> =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, isOffline });
        }
        return next;
      });

    const setPriority = (id: string, priority: number): Effect.Effect<void> =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, priority });
        }
        return next;
      });

    const getChannelsForCampaign = (campaign: Campaign): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError> =>
      Effect.gen(function* () {
        const onlineChannels: Channel[] = [];

        if (campaign.allowChannels.length > 0) {
          const response = yield* api.channelStreams(campaign.allowChannels.slice(0, 30));
          for (const u of response.users) {
            if (u.stream !== null) {
              onlineChannels.push({
                id: u.id,
                login: u.login,
                gameId: campaign.game.id,
                isOnline: true,
              });
            }
          }
        } else {
          const response = yield* api.gameDirectory(campaign.game.slug || '');
          if (response.game) {
            for (const e of response.game.streams.edges) {
              if (e.node.broadcaster !== null) {
                onlineChannels.push({
                  id: e.node.broadcaster.id,
                  login: e.node.broadcaster.login,
                  gameId: campaign.game.id,
                  isOnline: true,
                });
              }
            }
          }
        }

        if (onlineChannels.length === 0) return [];
        return yield* processOnlineChannels(api, socket, campaign.id, onlineChannels);
      });

    const addRewards = (rewards: ReadonlyArray<Reward>): Effect.Effect<void> =>
      Ref.update(rewardsRef, (current) => {
        const next = new Map(current);
        for (const reward of rewards) {
          next.set(reward.id, reward.lastAwardedAt);
        }
        return next;
      });

    return {
      campaigns: campaignsRef,
      progress: progressRef,
      rewards: rewardsRef,
      updateCampaigns,
      updateProgress,
      getSortedActive,
      getSortedUpcoming,
      getOffline,
      setOffline,
      setPriority,
      state: stateRef,
      getDropsForCampaign,
      getChannelsForCampaign,
      addRewards,
    } satisfies CampaignStore;
  }),
);
