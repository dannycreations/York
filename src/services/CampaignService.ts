import { truncate } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Option, Ref, Schema } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { GqlQueries } from '../api/TwitchGql';
import { TwitchSocketTag } from '../api/TwitchSocket';
import { ConfigStoreTag } from '../core/Config';
import { CampaignDetailsSchema, ChannelDropsSchema, InventorySchema } from '../core/Schemas';
import { CHANNEL_LISTENER_TOPICS } from '../helpers/ChannelHelper';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { makeTtlCache } from '../structures/CacheClient';

import type { TwitchApiError } from '../api/TwitchApi';
import type { TwitchSocket, TwitchSocketError } from '../api/TwitchSocket';
import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop, Reward } from '../core/Schemas';

type CampaignDetail = Schema.Schema.Type<typeof CampaignDetailsSchema>['user']['dropCampaign'];

interface RawDrop {
  readonly id: string;
  readonly name: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly requiredMinutesWatched: number;
  readonly requiredSubs: number;
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

export type CampaignServiceState = Data.TaggedEnum<{
  Initial: {};
  PriorityOnly: {};
  All: {};
}>;

export const CampaignServiceState = Data.taggedEnum<CampaignServiceState>();

const processDrop = (
  drop: RawDrop,
  campaignId: string,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
  allowUpcomingIfHasAward: boolean,
): Option.Option<Drop> => {
  const { startAt, endAt, requiredMinutesWatched, requiredSubs } = drop;
  const isClaimed = requiredSubs > 0 || (drop.self?.isClaimed ?? false);

  if (isClaimed) return Option.none();
  const benefits = drop.benefitEdges.map((e) => e.benefit.id);
  const hasBeenAwarded = benefits.some((benefitId) => {
    const lastAwardedAt = rewardsMap.get(benefitId);
    return lastAwardedAt !== undefined && lastAwardedAt >= startAt;
  });

  if (hasBeenAwarded) return Option.none();

  const currentMinutesWatched = drop.self?.currentMinutesWatched ?? 0;
  const isWatched = drop.self ? isMinutesWatchedMet({ ...drop.self, requiredMinutesWatched }) : false;

  if (isWatched && !config.isClaimDrops) return Option.none();

  const minutesLeft = requiredMinutesWatched - currentMinutesWatched;
  const status = getDropStatus(startAt, endAt, now, minutesLeft);

  if (status.isExpired) return Option.none();
  if (status.isUpcoming && (!allowUpcomingIfHasAward || !drop.self?.dropInstanceID)) return Option.none();

  return Option.some({
    id: drop.id,
    name: truncate((drop.benefitEdges[0]?.benefit.name || drop.name).trim()),
    benefits,
    campaignId,
    startAt,
    endAt,
    requiredMinutesWatched,
    requiredSubs,
    isClaimed,
    hasPreconditionsMet: drop.self?.hasPreconditionsMet ?? true,
    currentMinutesWatched,
    dropInstanceID: drop.self?.dropInstanceID || undefined,
  } satisfies Drop);
};

export interface CampaignService {
  readonly campaigns: Ref.Ref<ReadonlyMap<string, Campaign>>;
  readonly progress: Ref.Ref<ReadonlyArray<Drop>>;
  readonly rewards: Ref.Ref<ReadonlyMap<string, Date>>;
  readonly state: Ref.Ref<CampaignServiceState>;
  readonly updateCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly refreshCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly updateProgress: Effect.Effect<void, TwitchApiError>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setBroken: (id: string, isBroken: boolean) => Effect.Effect<void>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
  readonly setPriority: (id: string, priority: number) => Effect.Effect<void>;
  readonly getDropsForCampaign: (campaignId: string) => Effect.Effect<ReadonlyArray<Drop>, TwitchApiError>;
  readonly getChannelsForCampaign: (campaign: Campaign) => Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError>;
  readonly addRewards: (rewards: ReadonlyArray<Reward>) => Effect.Effect<void>;
}

export class CampaignServiceTag extends Context.Tag('@services/CampaignService')<CampaignServiceTag, CampaignService>() {}

const cleanupSocketListeners = (socket: TwitchSocket | undefined, channels: readonly Channel[]): Effect.Effect<void, TwitchSocketError> => {
  if (!socket || channels.length === 0) return Effect.void;
  return Effect.forEach(channels, (c) => Effect.forEach(CHANNEL_LISTENER_TOPICS, (topic) => socket.unlisten(topic, c.id), { discard: true }), {
    discard: true,
  });
};

const buildActiveDrops = (
  rawDrops: ReadonlyArray<RawDrop>,
  campaignId: string,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
  allowUpcomingIfHasAward: boolean,
  currentMinutesById?: ReadonlyMap<string, number>,
): ReadonlyArray<Drop> => {
  const sorted = [...rawDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);
  const processed: Drop[] = [];
  for (const d of sorted) {
    const opt = processDrop(d, campaignId, config, rewardsMap, now, allowUpcomingIfHasAward);
    if (Option.isNone(opt)) continue;
    const drop = opt.value;
    const override = currentMinutesById?.get(drop.id);
    processed.push(override === undefined ? drop : { ...drop, currentMinutesWatched: override });
  }

  const len = processed.length;
  const total = sorted.length;
  const startIndex = total - len;
  return processed.map((drop, i) => ({ ...drop, name: truncate(`${startIndex + i + 1}/${total}, ${drop.name}`) }));
};

const processInventoryDrops = (
  campaigns: ReadonlyArray<{ readonly id: string; readonly timeBasedDrops: ReadonlyArray<RawDrop> }>,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
): ReadonlyArray<Drop> => {
  const result: Drop[] = [];
  for (const campaign of campaigns) {
    result.push(...buildActiveDrops(campaign.timeBasedDrops, campaign.id, config, rewardsMap, now, true));
  }
  return result;
};

export const CampaignServiceLayer: Layer.Layer<CampaignServiceTag, never, TwitchApiTag | ConfigStoreTag | TwitchSocketTag> = Layer.effect(
  CampaignServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const socket = yield* Effect.serviceOption(TwitchSocketTag).pipe(Effect.map(Option.getOrUndefined));

    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyMap<string, Date>>(new Map());
    const stateRef = yield* Ref.make<CampaignServiceState>(CampaignServiceState.Initial());

    const campaignDetailsCache = yield* makeTtlCache<string, CampaignDetail>(300_000, 256);
    const candidateChannelsCache = yield* makeTtlCache<string, ReadonlyArray<Channel>>(60_000, 128);
    const dropCampaignIdsCache = yield* makeTtlCache<string, ReadonlySet<string>>(60_000, 512);

    const fetchCampaigns = Effect.gen(function* () {
      const [response, config] = yield* Effect.all([api.dropsDashboard, configStore.get]);
      const newPriorityGames: string[] = [];

      if (config.usePriorityConnected) {
        for (const data of response.currentUser.dropCampaigns) {
          if (data.game && data.self.isAccountConnected) {
            const gameName = data.game.displayName;
            if (!config.priorityList.has(gameName) && !config.priorityConnectedList.has(gameName)) {
              newPriorityGames.push(gameName);
            }
          }
        }
      }

      if (newPriorityGames.length > 0) {
        yield* configStore.update((c) => ({ ...c, priorityConnectedList: new Set([...c.priorityConnectedList, ...newPriorityGames]) }));
      }

      yield* Ref.update(campaignsRef, (existingMap) => {
        const nextMap = new Map<string, Campaign>();
        for (const data of response.currentUser.dropCampaigns) {
          if (data.game === null) continue;
          const gameName = data.game.displayName;
          if (config.exclusionList.has(gameName)) continue;
          if (config.isPriorityOnly && !config.priorityList.has(gameName)) continue;

          const existing = existingMap.get(data.id);
          nextMap.set(data.id, {
            id: data.id,
            name: truncate((existing?.name || data.name).trim()),
            game: existing?.game || data.game,
            startAt: data.startAt,
            endAt: data.endAt,
            isAccountConnected: data.self.isAccountConnected,
            priority: existing?.priority ?? 0,
            isBroken: existing?.isBroken ?? false,
            isOffline: existing?.isOffline ?? false,
            allowChannels: existing?.allowChannels ?? [],
          });
        }
        return nextMap;
      });
    });

    const [cachedFetchCampaigns, invalidateFetchCampaigns] = yield* Effect.cachedInvalidateWithTTL(fetchCampaigns, '10 minutes');
    const updateCampaigns = cachedFetchCampaigns.pipe(Effect.tapErrorCause(() => invalidateFetchCampaigns));
    const refreshCampaigns = invalidateFetchCampaigns.pipe(Effect.zipRight(updateCampaigns));

    const syncProgressRef = (newDrops: ReadonlyArray<Drop>, now: number) =>
      Ref.update(progressRef, (current) => {
        const currentMap = new Map(current.map((d) => [d.id, d]));
        let changed = false;

        for (const [id, drop] of currentMap) {
          if (drop.endAt.getTime() < now) {
            currentMap.delete(id);
            changed = true;
          }
        }

        for (const drop of newDrops) {
          const existing = currentMap.get(drop.id);
          const isStateChanged =
            existing &&
            (existing.currentMinutesWatched !== drop.currentMinutesWatched ||
              existing.isClaimed !== drop.isClaimed ||
              existing.dropInstanceID !== drop.dropInstanceID);

          if (!existing || isStateChanged) {
            currentMap.set(drop.id, drop);
            changed = true;
          }
        }

        return changed || currentMap.size !== current.length ? Array.from(currentMap.values()) : current;
      });

    const syncInventory = (
      inventory: Schema.Schema.Type<typeof InventorySchema>,
      config: ClientConfig,
      now: number,
    ): Effect.Effect<ReadonlyMap<string, Date>> =>
      Effect.gen(function* () {
        const rewardsMap = new Map<string, Date>();
        const userInventory = inventory.currentUser.inventory;

        for (const drop of userInventory.gameEventDrops) {
          if (now - drop.lastAwardedAt.getTime() < 2_592_000_000) {
            rewardsMap.set(drop.id, drop.lastAwardedAt);
          }
        }

        yield* Ref.set(rewardsRef, rewardsMap);
        yield* syncProgressRef(processInventoryDrops(userInventory.dropCampaignsInProgress, config, rewardsMap, now), now);
        return rewardsMap;
      });

    const updateProgress = Effect.gen(function* () {
      const config = yield* configStore.get;
      yield* syncInventory(yield* api.inventory, config, Date.now());
      yield* campaignDetailsCache.invalidateAll;
    });

    const loadCampaignDetail = (
      campaignId: string,
      config: ClientConfig,
      now: number,
    ): Effect.Effect<{ readonly detail: CampaignDetail | undefined; readonly rewards: ReadonlyMap<string, Date> }, TwitchApiError> =>
      Effect.gen(function* () {
        const cached = yield* campaignDetailsCache.get(campaignId);

        if (Option.isSome(cached)) {
          return { detail: cached.value, rewards: yield* Ref.get(rewardsRef) };
        }

        const [detailRes, invRes] = (yield* api.graphqlBatch(
          [GqlQueries.campaignDetails(campaignId), GqlQueries.inventory],
          [CampaignDetailsSchema, InventorySchema],
        )) as [Schema.Schema.Type<typeof CampaignDetailsSchema>, Schema.Schema.Type<typeof InventorySchema>];

        const rewards = yield* syncInventory(invRes, config, now);
        const detail = detailRes.user?.dropCampaign;

        if (detail) {
          yield* campaignDetailsCache.set(campaignId, detail);
        }

        return { detail, rewards };
      });

    const getDropsForCampaign = (campaignId: string): Effect.Effect<ReadonlyArray<Drop>, TwitchApiError> =>
      Effect.gen(function* () {
        const config = yield* configStore.get;
        const now = Date.now();

        const { detail: dropDetail, rewards: rewardsMap } = yield* loadCampaignDetail(campaignId, config, now);

        if (!dropDetail) {
          yield* Ref.update(campaignsRef, (map) => {
            const next = new Map(map);
            next.delete(campaignId);
            return next;
          });
          return [];
        }

        yield* Ref.update(campaignsRef, (map) => {
          const existing = map.get(campaignId);
          if (!existing) return map;
          const next = new Map(map);
          next.set(campaignId, {
            ...existing,
            name: truncate(dropDetail.name.trim()),
            game: dropDetail.game || existing.game,
            allowChannels: dropDetail.allow?.channels?.map((c) => c.name) ?? [],
          });
          return next;
        });

        if (!dropDetail.timeBasedDrops || dropDetail.timeBasedDrops.length === 0) return [];

        const progress = yield* Ref.get(progressRef);
        const progressMap = new Map(progress.map((d) => [d.id, d.currentMinutesWatched]));
        const result = buildActiveDrops(dropDetail.timeBasedDrops, campaignId, config, rewardsMap, now, false, progressMap);

        yield* syncProgressRef(result, now);
        return result;
      });

    const getSortedActive = Effect.gen(function* () {
      const currentState = yield* Ref.get(stateRef);
      const config = yield* configStore.get;
      const now = Date.now();

      const campaigns = Array.from((yield* Ref.get(campaignsRef)).values()).filter((c) => {
        if (c.isBroken || c.isOffline || c.game === null) return false;
        return !getDropStatus(c.startAt, c.endAt, now).isExpired;
      });

      let targets = campaigns;
      if (currentState._tag === 'PriorityOnly') {
        targets = campaigns.filter(
          (c) => c.game !== null && (config.priorityList.has(c.game.displayName) || config.priorityConnectedList.has(c.game.displayName)),
        );
      }

      const result: Campaign[] = [];
      const seenGames = new Set<string>();
      for (const c of targets) {
        if (c.game === null || seenGames.has(c.game.id)) continue;
        seenGames.add(c.game.id);
        result.push(c);
      }

      return result.sort((a, b) => {
        if (a.game !== null && b.game !== null) {
          const aP = config.priorityList.has(a.game.displayName);
          const bP = config.priorityList.has(b.game.displayName);
          if (aP && !bP) return -1;
          if (!aP && bP) return 1;
          const aPC = config.priorityConnectedList.has(a.game.displayName);
          const bPC = config.priorityConnectedList.has(b.game.displayName);
          if (aPC && !bPC) return -1;
          if (!aPC && bPC) return 1;
        }
        return b.priority - a.priority || a.endAt.getTime() - b.endAt.getTime();
      });
    });

    const setCampaignField = (id: string, update: (c: Campaign) => Campaign): Effect.Effect<void> =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const c = next.get(id);
        if (c) next.set(id, update(c));
        return next;
      });

    const resolveDropCampaignIds = (channelIds: readonly string[]): Effect.Effect<ReadonlyMap<string, ReadonlySet<string>>, TwitchApiError> =>
      Effect.gen(function* () {
        const { hits, misses } = yield* dropCampaignIdsCache.partition(channelIds);

        if (misses.length === 0) return hits;

        const responses = yield* api.graphql(
          misses.map((id) => GqlQueries.channelDrops(id)),
          ChannelDropsSchema,
        );

        const entries = misses.map(
          (id, index) =>
            [id, new Set((responses[index].channel.viewerDropCampaigns ?? []).map((vc) => vc.id))] as readonly [string, ReadonlySet<string>],
        );

        yield* dropCampaignIdsCache.setAll(entries);
        return new Map<string, ReadonlySet<string>>([...hits, ...entries]);
      });

    const resolveCandidateChannels = (campaign: Campaign): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> =>
      Effect.gen(function* () {
        const game = campaign.game;
        if (game === null) return [];

        const allowChannels = campaign.allowChannels.slice(0, 30);
        const cacheKey = `${game.id}|${game.slug ?? ''}|${allowChannels.join(',')}`;

        const cached = yield* candidateChannelsCache.get(cacheKey);
        if (Option.isSome(cached)) return cached.value;

        const toChannel = (id: string, login: string, sid: string, currentGameId: string, currentGameName: string): Channel => ({
          id,
          login,
          gameId: game.id,
          isOnline: true,
          currentSid: sid,
          currentGameId,
          currentGameName,
        });

        const candidates: Channel[] = [];

        if (allowChannels.length > 0) {
          const res = yield* api.channelStreams(allowChannels);
          for (const u of res.users) {
            if (u.stream) candidates.push(toChannel(u.id, u.login, u.stream.id, game.id, game.displayName));
          }
        } else {
          const res = yield* api.gameDirectory(game.slug || '');
          const broadcasters = (res.game?.streams.edges ?? []).map((e) => e.node.broadcaster).filter((b): b is NonNullable<typeof b> => b != null);

          if (broadcasters.length > 0) {
            const streams = yield* api.helixStreams(broadcasters.map((b) => b.id)).pipe(Effect.option);
            if (Option.isNone(streams)) return [];

            const streamById = new Map(streams.value.data.map((s) => [s.user_id, s]));

            for (const b of broadcasters) {
              const live = streamById.get(b.id);
              if (!live) continue;
              candidates.push(toChannel(b.id, b.login, live.id, live.game_id, live.game_name));
            }
          }
        }

        yield* candidateChannelsCache.set(cacheKey, candidates);
        return candidates;
      });

    return {
      campaigns: campaignsRef,
      progress: progressRef,
      rewards: rewardsRef,
      state: stateRef,
      updateCampaigns,
      refreshCampaigns,
      updateProgress,
      getSortedActive,
      getSortedUpcoming: Effect.gen(function* () {
        const now = Date.now();
        return Array.from((yield* Ref.get(campaignsRef)).values())
          .filter((c) => getDropStatus(c.startAt, c.endAt, now).isUpcoming)
          .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      }),
      setBroken: (id, isBroken) => setCampaignField(id, (c) => ({ ...c, isBroken })),
      setOffline: (id, isOffline) => setCampaignField(id, (c) => ({ ...c, isOffline })),
      setPriority: (id, priority) => setCampaignField(id, (c) => ({ ...c, priority })),
      getDropsForCampaign,
      getChannelsForCampaign: (campaign) =>
        Effect.gen(function* () {
          const candidates = yield* resolveCandidateChannels(campaign);
          if (candidates.length === 0) return [];

          const dropCampaignIds = yield* resolveDropCampaignIds(candidates.map((c) => c.id));
          const filtered = candidates
            .filter((c) => dropCampaignIds.get(c.id)?.has(campaign.id) ?? false)
            .map((c) => ({ ...c, campaignId: campaign.id }));
          const filteredIds = new Set(filtered.map((f) => f.id));

          yield* cleanupSocketListeners(
            socket,
            candidates.filter((oc) => !filteredIds.has(oc.id)),
          );

          return filtered;
        }),
      addRewards: (rewards) =>
        Effect.gen(function* () {
          yield* Ref.update(rewardsRef, (current) => {
            const next = new Map(current);
            for (const r of rewards) next.set(r.id, r.lastAwardedAt);
            return next;
          });
          yield* campaignDetailsCache.invalidateAll;
        }),
    } satisfies CampaignService;
  }),
);
