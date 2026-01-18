import { truncate } from '@vegapunk/utilities/common';
import { Array, Context, Effect, Layer, Option, Order, Ref, Schema } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { ChannelDropsSchema, ViewerDropsDashboardSchema } from '../core/Schemas';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { TwitchApiTag } from '../services/TwitchApi';
import { GqlQueries } from '../services/TwitchQueries';
import { TwitchSocketTag } from '../services/TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop, Reward } from '../core/Schemas';
import type { TwitchApi, TwitchApiError } from '../services/TwitchApi';
import type { TwitchSocket, TwitchSocketError } from '../services/TwitchSocket';
import type { StoreClient } from '../structures/StoreClient';

export type CampaignStoreState = 'Initial' | 'PriorityOnly' | 'All';

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
  currentRewards: ReadonlyArray<Reward>,
  now: number,
  allowUpcomingIfHasAward: boolean,
): Option.Option<Drop> => {
  const benefits = drop.benefitEdges.map((e) => e.benefit.id);
  const { startAt, endAt, requiredMinutesWatched } = drop;

  const isClaimed = (drop.requiredSubs ?? 0) > 0 || (drop.self?.isClaimed ?? false);
  const isWatched = drop.self ? isMinutesWatchedMet({ ...drop.self, requiredMinutesWatched }) : false;
  const alreadyClaimed = benefits.some((id) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));

  if ((isWatched && !config.isClaimDrops) || alreadyClaimed || isClaimed) {
    return Option.none();
  }

  const minutesLeft = requiredMinutesWatched - (drop.self?.currentMinutesWatched ?? 0);
  const status = getDropStatus(startAt, endAt, now, minutesLeft);
  const hasAward = !!drop.self?.dropInstanceID;

  if (status.isExpired || (status.isUpcoming && (!allowUpcomingIfHasAward || !hasAward))) {
    return Option.none();
  }

  return Option.some({
    id: drop.id,
    name: truncate(drop.benefitEdges[0]?.benefit.name?.trim() ?? drop.name.trim()),
    benefits,
    campaignId,
    startAt,
    endAt,
    requiredMinutesWatched,
    requiredSubs: (drop.requiredSubs ?? 0) > 0 ? drop.requiredSubs! : undefined,
    isClaimed,
    hasPreconditionsMet: drop.self?.hasPreconditionsMet ?? true,
    currentMinutesWatched: drop.self?.currentMinutesWatched ?? 0,
    dropInstanceID: drop.self?.dropInstanceID || undefined,
  } satisfies Drop);
};

export interface CampaignStore {
  readonly campaigns: Ref.Ref<ReadonlyMap<string, Campaign>>;
  readonly progress: Ref.Ref<ReadonlyArray<Drop>>;
  readonly rewards: Ref.Ref<ReadonlyArray<Reward>>;
  readonly updateCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly updateProgress: Effect.Effect<void, TwitchApiError>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getOffline: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
  readonly setPriority: (id: string, priority: number) => Effect.Effect<void>;
  readonly state: Ref.Ref<CampaignStoreState>;
  readonly getDropsForCampaign: (campaignId: string) => Effect.Effect<ReadonlyArray<Drop>, TwitchApiError>;
  readonly getChannelsForCampaign: (campaign: Campaign) => Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError>;
  readonly addRewards: (rewards: ReadonlyArray<Reward>) => Effect.Effect<void>;
}

export class CampaignStoreTag extends Context.Tag('@services/CampaignStore')<CampaignStoreTag, CampaignStore>() {}

const filterChannelsByCampaign = (
  api: TwitchApi,
  channels: readonly Channel[],
  campaignId: string,
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> =>
  Array.isEmptyReadonlyArray(channels)
    ? Effect.succeed([])
    : api
        .graphql(
          channels.map((c) => GqlQueries.channelDrops(c.id)),
          ChannelDropsSchema,
        )
        .pipe(
          Effect.map((responses) => channels.filter((_, i) => responses[i].channel.viewerDropCampaigns?.some((vc) => vc.id === campaignId) ?? false)),
        );

const cleanupSocketListeners = (socket: TwitchSocket | undefined, channels: readonly Channel[]): Effect.Effect<void, TwitchSocketError> =>
  !socket || Array.isEmptyReadonlyArray(channels)
    ? Effect.void
    : Effect.forEach(
        channels,
        (c) =>
          Effect.all(
            [
              socket.unlisten(WsTopic.ChannelStream, c.id),
              socket.unlisten(WsTopic.ChannelMoment, c.id),
              socket.unlisten(WsTopic.ChannelUpdate, c.id),
            ],
            { discard: true },
          ),
        { discard: true },
      );

const processOnlineChannels = (
  api: TwitchApi,
  socket: TwitchSocket | undefined,
  campaignId: string,
  channels: readonly Channel[],
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError> =>
  Effect.gen(function* () {
    const filtered = yield* filterChannelsByCampaign(api, channels, campaignId);
    yield* cleanupSocketListeners(
      socket,
      channels.filter((oc) => !filtered.some((f) => f.id === oc.id)),
    );
    return filtered;
  });

const processCampaignData = (
  data: Schema.Schema.Type<typeof ViewerDropsDashboardSchema>['currentUser']['dropCampaigns'][number],
  existingCampaigns: ReadonlyMap<string, Campaign>,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<Option.Option<Campaign>> =>
  Effect.gen(function* () {
    const config = yield* configStore.get;
    const gameName = data.game.displayName;
    if (config.exclusionList.has(gameName)) return Option.none();

    if (config.usePriorityConnected && data.self.isAccountConnected && !config.priorityList.has(gameName)) {
      yield* configStore.update((c) => ({
        ...c,
        priorityList: new Set([...c.priorityList, gameName]),
      }));
    }

    const latestConfig = yield* configStore.get;
    if (latestConfig.isPriorityOnly && !latestConfig.priorityList.has(gameName)) return Option.none();

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
  });

const processInventoryDrops = (
  campaigns: ReadonlyArray<{
    readonly id: string;
    readonly timeBasedDrops: ReadonlyArray<RawDrop>;
  }>,
  config: ClientConfig,
  currentRewards: ReadonlyArray<Reward>,
  now: number,
): ReadonlyArray<Drop> =>
  Array.flatMap(campaigns, (campaign) => {
    const sortedDrops = Array.sort(
      campaign.timeBasedDrops,
      Order.mapInput(Order.number, (d: { readonly requiredMinutesWatched: number }) => d.requiredMinutesWatched),
    );
    const filtered = Array.filterMap(sortedDrops, (data) => processDrop(data, campaign.id, config, currentRewards, now, true));

    return filtered.map((drop, i) => ({
      ...drop,
      name: truncate(`${i + 1}/${filtered.length}, ${drop.name}`),
    }));
  });

const groupCampaigns = (campaigns: ReadonlyArray<Campaign>): ReadonlyArray<Campaign> =>
  Array.reduce(campaigns, [] as Campaign[], (acc, campaign) => {
    const existingIndex = acc.findIndex((c) => c.game.id === campaign.game.id);
    if (existingIndex === -1) {
      return [...acc, campaign];
    }

    const existing = acc[existingIndex];
    if (campaign.startAt < existing.startAt) {
      const next = [...acc];
      next[existingIndex] = campaign;
      return next;
    }

    return acc;
  });

export const CampaignStoreLayer: Layer.Layer<CampaignStoreTag, never, TwitchApiTag | ConfigStoreTag | TwitchSocketTag> = Layer.effect(
  CampaignStoreTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const socket = yield* Effect.serviceOption(TwitchSocketTag).pipe(Effect.map(Option.getOrUndefined));
    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyArray<Reward>>([]);
    const stateRef = yield* Ref.make<CampaignStoreState>('Initial');

    const updateCampaigns: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const response = yield* api.dropsDashboard;
      const existingCampaigns = yield* Ref.get(campaignsRef);
      const newCampaigns = new Map<string, Campaign>();

      yield* Effect.forEach(
        response.currentUser.dropCampaigns,
        (data) =>
          Effect.gen(function* () {
            const campaign = yield* processCampaignData(data, existingCampaigns, configStore);
            if (Option.isSome(campaign)) {
              newCampaigns.set(campaign.value.id, campaign.value);
            }
          }),
        { discard: true, concurrency: 10 },
      );
      yield* Ref.set(campaignsRef, newCampaigns);
    });

    const updateProgress: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.inventory;
      const now = Date.now();

      const newRewards = response.currentUser.inventory.gameEventDrops
        .map((d) => ({ id: d.id, lastAwardedAt: d.lastAwardedAt }))
        .filter((r) => now - r.lastAwardedAt.getTime() < REWARD_EXPIRED_MS);

      yield* Ref.set(rewardsRef, newRewards);

      const newProgress = processInventoryDrops(response.currentUser.inventory.dropCampaignsInProgress, config, newRewards, now);

      yield* Ref.update(progressRef, (current) =>
        Array.reduce(newProgress, [...current], (acc, drop) => {
          const index = acc.findIndex((d) => d.id === drop.id);
          if (index !== -1) {
            acc[index] = drop;
          } else {
            acc.push(drop);
          }
          return acc;
        }),
      );
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

        const currentRewards = yield* Ref.get(rewardsRef);
        const sortedDrops = Array.sort(
          dropDetail.timeBasedDrops,
          Order.mapInput(Order.number, (d: { readonly requiredMinutesWatched: number }) => d.requiredMinutesWatched),
        );

        const config = yield* configStore.get;
        const activeDrops = Array.filterMap(sortedDrops, (data) => processDrop(data, campaignId, config, currentRewards, Date.now(), false));

        const result = activeDrops.map((drop, i) => ({
          ...drop,
          name: truncate(`${i + 1}/${activeDrops.length}, ${drop.name}`),
        }));

        yield* Ref.update(progressRef, (current) =>
          Array.reduce(result, [...current], (acc, drop) => {
            const index = acc.findIndex((d) => d.id === drop.id);
            if (index !== -1) {
              acc[index] = drop;
            } else {
              acc.push(drop);
            }
            return acc;
          }),
        );

        return result;
      });

    const getSortedActive: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      const state = yield* Ref.get(stateRef);
      const config = yield* configStore.get;

      const activeCampaigns = Array.fromIterable(map.values()).filter((c) => {
        if (c.isOffline) return false;
        const status = getDropStatus(c.startAt, c.endAt, Date.now());
        if (status.isExpired) return false;
        if (state === 'PriorityOnly' && !config.priorityList.has(c.game.displayName)) return false;
        return true;
      });

      const sortedByEndAt = Array.sort(
        activeCampaigns,
        Order.mapInput(Order.number, (c: Campaign) => c.endAt.getTime()),
      );

      const dropCampaigns = groupCampaigns(sortedByEndAt);

      return Array.sort(dropCampaigns, Order.reverse(Order.mapInput(Order.number, (c: Campaign) => c.priority)));
    });

    const getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      const now = Date.now();
      return Array.fromIterable(map.values())
        .filter((c) => getDropStatus(c.startAt, c.endAt, now).isUpcoming)
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    });

    const getOffline: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      return Array.fromIterable(map.values()).filter((c) => c.isOffline);
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
        if (campaign.allowChannels.length > 0) {
          const response = yield* api.channelStreams(campaign.allowChannels.slice(0, 30));
          const onlineChannels = Array.filterMap(response.users, (user) => {
            if (!user.stream) {
              return Option.none();
            }
            return Option.some({
              id: user.id,
              login: user.login,
              gameId: campaign.game.id,
              isOnline: true,
            } satisfies Channel);
          });
          return yield* processOnlineChannels(api, socket, campaign.id, onlineChannels);
        }

        const response = yield* api.gameDirectory(campaign.game.slug || '');
        if (!response.game) return [];

        const onlineChannels = Array.filterMap(response.game.streams.edges, (edge) => {
          if (!edge.node.broadcaster) {
            return Option.none();
          }
          return Option.some({
            id: edge.node.broadcaster.id,
            login: edge.node.broadcaster.login,
            gameId: campaign.game.id,
            isOnline: true,
          } satisfies Channel);
        });
        return yield* processOnlineChannels(api, socket, campaign.id, onlineChannels);
      });

    const addRewards = (rewards: ReadonlyArray<Reward>): Effect.Effect<void> =>
      Ref.update(rewardsRef, (current) =>
        Array.reduce(rewards, [...current], (acc, reward) => {
          const index = acc.findIndex((r) => r.id === reward.id);
          if (index !== -1) {
            acc[index] = reward;
          } else {
            acc.push(reward);
          }
          return acc;
        }),
      );

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
