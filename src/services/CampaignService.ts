import { chalk } from '@vegapunk/utilities';
import { truncate } from '@vegapunk/utilities/common';
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi.js';
import { GqlQueries } from '../api/TwitchGql.js';
import { ConfigStoreTag, gamePriorityRank } from '../core/Config.js';
import {
  CampaignDetailsSchema,
  ChannelDropsSchema,
  ChannelStreamsSchema,
  ClaimDropsSchema,
  GameDirectorySchema,
  InventorySchema,
} from '../core/Schemas.js';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper.js';
import { makeTtlCache } from '../structures/CacheClient.js';

import type { TwitchApiError } from '../api/TwitchApi.js';
import type { ClientConfig } from '../core/Config.js';
import type { Campaign, Channel, Drop, Game, Reward, TimeBasedDrop } from '../core/Schemas.js';

const GQL_BATCH_SIZE = 20;
const ALLOW_CHANNEL_LIMIT = 30;
const INVENTORY_FRESH_MS = 60_000;
const REWARD_RETENTION_MS = 2_592_000_000;

type CampaignDetail = Schema.Schema.Type<typeof CampaignDetailsSchema>['user']['dropCampaign'];

type DetailSchema = typeof CampaignDetailsSchema;

type CandidateSchema = typeof ChannelStreamsSchema | typeof GameDirectorySchema;

type Inventory = Schema.Schema.Type<typeof InventorySchema>;

interface CandidateJob {
  readonly key: string;
  readonly game: Game;
  readonly allowChannels: ReadonlyArray<string>;
}

const chunked = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
};

const candidateKey = (game: Game, allowChannels: ReadonlyArray<string>): string => `${game.id}|${game.slug ?? ''}|${allowChannels.join(',')}`;

const toCandidateJob = (campaign: Campaign): CandidateJob | undefined => {
  const game = campaign.game;
  if (game === null) return undefined;

  const allowChannels = campaign.allowChannels.slice(0, ALLOW_CHANNEL_LIMIT);
  return { key: candidateKey(game, allowChannels), game, allowChannels };
};

export type CampaignMode = 'Initial' | 'PriorityOnly' | 'All';

const processDrop = (
  drop: TimeBasedDrop,
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
  readonly getMode: Effect.Effect<CampaignMode>;
  readonly setMode: (mode: CampaignMode) => Effect.Effect<void>;
  readonly listCampaigns: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getCampaign: (id: string) => Effect.Effect<Option.Option<Campaign>>;
  readonly removeCampaign: (id: string) => Effect.Effect<void>;
  readonly findProgress: (dropId: string) => Effect.Effect<Option.Option<Drop>>;
  readonly updateCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly updateProgress: Effect.Effect<void, TwitchApiError>;
  readonly claimInventoryDrops: Effect.Effect<void, TwitchApiError>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setBroken: (id: string, isBroken: boolean) => Effect.Effect<void>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
  readonly setPriority: (id: string, priority: number) => Effect.Effect<void>;
  readonly getDropsForCampaign: (campaignId: string) => Effect.Effect<ReadonlyArray<Drop>, TwitchApiError>;
  readonly primeCampaignDetails: (campaignIds: ReadonlyArray<string>) => Effect.Effect<void, TwitchApiError>;
  readonly getChannelsForCampaign: (campaign: Campaign) => Effect.Effect<ReadonlyArray<Channel>, TwitchApiError>;
  readonly primeCampaignChannels: (campaigns: ReadonlyArray<Campaign>) => Effect.Effect<void, TwitchApiError>;
  readonly addRewards: (rewards: ReadonlyArray<Reward>) => Effect.Effect<void>;
}

export class CampaignServiceTag extends Context.Tag('@services/CampaignService')<CampaignServiceTag, CampaignService>() {}

const buildActiveDrops = (
  rawDrops: ReadonlyArray<TimeBasedDrop>,
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
  campaigns: ReadonlyArray<{ readonly id: string; readonly timeBasedDrops: ReadonlyArray<TimeBasedDrop> }>,
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

export const CampaignServiceLayer: Layer.Layer<CampaignServiceTag, never, TwitchApiTag | ConfigStoreTag> = Layer.effect(
  CampaignServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;

    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyMap<string, Date>>(new Map());
    const modeRef = yield* Ref.make<CampaignMode>('Initial');
    const inventorySyncedAtRef = yield* Ref.make(0);

    const campaignDetailsCache = yield* makeTtlCache<string, CampaignDetail>(300_000, 256);
    const candidateChannelsCache = yield* makeTtlCache<string, ReadonlyArray<Channel>>(60_000, 128);
    // Which campaigns a channel carries drops for is effectively static for the
    // lifetime of a stream, so this outlives the 120s offline sweep interval.
    const dropCampaignIdsCache = yield* makeTtlCache<string, ReadonlySet<string>>(300_000, 512);

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

    // Rewards feed the "already awarded" filter applied when drops are rebuilt,
    // so updating the map is enough; cached campaign details stay valid.
    const addRewards = (rewards: ReadonlyArray<Reward>): Effect.Effect<void> =>
      Ref.update(rewardsRef, (current) => {
        const next = new Map(current);
        for (const r of rewards) next.set(r.id, r.lastAwardedAt);
        return next;
      });

    const syncInventory = (inventory: Inventory, config: ClientConfig, now: number): Effect.Effect<ReadonlyMap<string, Date>> =>
      Effect.gen(function* () {
        const rewardsMap = new Map<string, Date>();
        const userInventory = inventory.currentUser.inventory;

        for (const drop of userInventory.gameEventDrops) {
          if (now - drop.lastAwardedAt.getTime() < REWARD_RETENTION_MS) {
            rewardsMap.set(drop.id, drop.lastAwardedAt);
          }
        }

        yield* Ref.set(rewardsRef, rewardsMap);
        yield* Ref.set(inventorySyncedAtRef, now);
        yield* syncProgressRef(processInventoryDrops(userInventory.dropCampaignsInProgress, config, rewardsMap, now), now);
        return rewardsMap;
      });

    const fetchAndSyncInventory = Effect.gen(function* () {
      const config = yield* configStore.get;
      const inventory = yield* api.inventory;
      yield* syncInventory(inventory, config, Date.now());
      return inventory;
    });

    // Inventory drives both live progress and the reward filter, so it is
    // synced through one shared guard: callers within INVENTORY_FRESH_MS of the
    // last sync reuse it instead of each issuing their own round trip.
    const syncInventoryIfStale = (now: number): Effect.Effect<void, TwitchApiError> =>
      Ref.get(inventorySyncedAtRef).pipe(Effect.flatMap((last) => (now - last >= INVENTORY_FRESH_MS ? fetchAndSyncInventory : Effect.void)));

    // Campaign details describe the immutable shape of a campaign's drops; live
    // progress and rewards are layered on at read time, so a progress refresh
    // must not invalidate the detail cache.
    const updateProgress = Effect.asVoid(syncInventoryIfStale(Date.now()));

    const claimInventoryDrops = Effect.gen(function* () {
      yield* syncInventoryIfStale(Date.now());

      const pending = (yield* Ref.get(progressRef)).filter(
        (d): d is Drop & { dropInstanceID: string } => !d.isClaimed && d.dropInstanceID !== undefined,
      );
      if (pending.length === 0) return;

      const claimed = yield* api
        .graphql(
          pending.map((d) => GqlQueries.claimDrops(d.dropInstanceID)),
          ClaimDropsSchema,
        )
        .pipe(Effect.option);

      if (Option.isNone(claimed)) return;

      // Rewards are recorded locally from the payload we already hold, which
      // avoids a second inventory round trip just to observe the claims.
      const awarded: Reward[] = [];
      const now = new Date();
      for (const [index, res] of claimed.value.entries()) {
        if (!res.claimDropRewards) continue;

        const drop = pending[index];
        yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
        for (const id of drop.benefits) awarded.push({ id, lastAwardedAt: now });
      }

      if (awarded.length > 0) yield* addRewards(awarded);
    });

    const ensureCampaignDetails = (campaignIds: ReadonlyArray<string>, config: ClientConfig, now: number): Effect.Effect<void, TwitchApiError> =>
      Effect.gen(function* () {
        const { misses } = yield* campaignDetailsCache.partition(campaignIds);

        if (misses.length === 0) {
          return;
        }

        let needsInventory = now - (yield* Ref.get(inventorySyncedAtRef)) >= INVENTORY_FRESH_MS;

        for (const chunk of chunked(misses, GQL_BATCH_SIZE)) {
          const withInventory = needsInventory;
          needsInventory = false;

          const detailRequests = chunk.map((id) => GqlQueries.campaignDetails(id));
          const detailSchemas: ReadonlyArray<DetailSchema> = chunk.map(() => CampaignDetailsSchema);

          const responses = yield* api.graphqlBatch(
            withInventory ? [GqlQueries.inventory, ...detailRequests] : detailRequests,
            withInventory ? [InventorySchema, ...detailSchemas] : detailSchemas,
          );

          const head = responses[0];
          if (withInventory && head && !('user' in head)) {
            yield* syncInventory(head, config, now);
          }

          const detailOffset = withInventory ? 1 : 0;
          const entries: Array<readonly [string, CampaignDetail]> = [];

          for (const [index, campaignId] of chunk.entries()) {
            const response = responses[index + detailOffset];
            const detail = response && 'user' in response ? response.user?.dropCampaign : undefined;

            if (detail) {
              entries.push([campaignId, detail]);
            }
          }

          if (entries.length > 0) {
            yield* campaignDetailsCache.setAll(entries);
          }
        }
      });

    const getDropsForCampaign = (campaignId: string): Effect.Effect<ReadonlyArray<Drop>, TwitchApiError> =>
      Effect.gen(function* () {
        const config = yield* configStore.get;
        const now = Date.now();

        yield* ensureCampaignDetails([campaignId], config, now);
        const cached = yield* campaignDetailsCache.get(campaignId);

        if (Option.isNone(cached)) {
          yield* Ref.update(campaignsRef, (map) => {
            const next = new Map(map);
            next.delete(campaignId);
            return next;
          });
          return [];
        }

        const dropDetail = cached.value;

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

        const rewardsMap = yield* Ref.get(rewardsRef);
        const progress = yield* Ref.get(progressRef);
        const progressMap = new Map(progress.map((d) => [d.id, d.currentMinutesWatched]));
        const result = buildActiveDrops(dropDetail.timeBasedDrops, campaignId, config, rewardsMap, now, false, progressMap);

        yield* syncProgressRef(result, now);
        return result;
      });

    const getSortedActive = Effect.gen(function* () {
      const mode = yield* Ref.get(modeRef);
      const config = yield* configStore.get;
      const now = Date.now();

      const campaigns = Array.from((yield* Ref.get(campaignsRef)).values()).filter((c) => {
        if (c.isBroken || c.isOffline || c.game === null) return false;
        return !getDropStatus(c.startAt, c.endAt, now).isExpired;
      });

      let targets = campaigns;
      if (mode === 'PriorityOnly') {
        targets = campaigns.filter((c) => gamePriorityRank(config, c.game?.displayName) > 0);
      }

      const result: Campaign[] = [];
      const seenGames = new Set<string>();
      for (const c of targets) {
        if (c.game === null || seenGames.has(c.game.id)) continue;
        seenGames.add(c.game.id);
        result.push(c);
      }

      return result.sort(
        (a, b) =>
          gamePriorityRank(config, b.game?.displayName) - gamePriorityRank(config, a.game?.displayName) ||
          b.priority - a.priority ||
          a.endAt.getTime() - b.endAt.getTime(),
      );
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

        const resolved = new Map<string, ReadonlySet<string>>(hits);

        for (const chunk of chunked(misses, GQL_BATCH_SIZE)) {
          const responses = yield* api.graphql(
            chunk.map((id) => GqlQueries.channelDrops(id)),
            ChannelDropsSchema,
          );

          const entries = chunk.map(
            (id, index) =>
              [id, new Set((responses[index].channel.viewerDropCampaigns ?? []).map((vc) => vc.id))] as readonly [string, ReadonlySet<string>],
          );

          yield* dropCampaignIdsCache.setAll(entries);
          for (const [id, campaignIds] of entries) resolved.set(id, campaignIds);
        }

        return resolved;
      });

    const toChannel = (game: Game, id: string, login: string, sid: string, currentGameId: string, currentGameName: string): Channel => ({
      id,
      login,
      gameId: game.id,
      isOnline: true,
      currentSid: sid,
      currentGameId,
      currentGameName,
    });

    const ensureCandidateChannels = (campaigns: ReadonlyArray<Campaign>): Effect.Effect<void, TwitchApiError> =>
      Effect.gen(function* () {
        const jobs: CandidateJob[] = [];
        const seen = new Set<string>();

        for (const campaign of campaigns) {
          const job = toCandidateJob(campaign);
          if (!job || seen.has(job.key)) continue;
          seen.add(job.key);

          const cached = yield* candidateChannelsCache.get(job.key);
          if (Option.isNone(cached)) jobs.push(job);
        }

        for (const chunk of chunked(jobs, GQL_BATCH_SIZE)) {
          const responses = yield* api.graphqlBatch(
            chunk.map((job) =>
              job.allowChannels.length > 0 ? GqlQueries.channelStreams(job.allowChannels) : GqlQueries.gameDirectory(job.game.slug || ''),
            ),
            chunk.map((job): CandidateSchema => (job.allowChannels.length > 0 ? ChannelStreamsSchema : GameDirectorySchema)),
          );

          const resolved = chunk.map((): Channel[] => []);
          const unresolved: Array<{ readonly index: number; readonly id: string; readonly login: string }> = [];

          for (const [index, job] of chunk.entries()) {
            const response = responses[index];
            if (!response) continue;

            if ('users' in response) {
              for (const user of response.users) {
                if (user?.stream) resolved[index].push(toChannel(job.game, user.id, user.login, user.stream.id, job.game.id, job.game.displayName));
              }
              continue;
            }

            // The directory already carries the live stream for most entries, so
            // Helix is only consulted for the leftovers.
            for (const edge of response.game?.streams.edges ?? []) {
              const node = edge.node;

              if (node.id && node.game) {
                resolved[index].push(toChannel(job.game, node.broadcaster.id, node.broadcaster.login, node.id, node.game.id, node.game.displayName));
                continue;
              }

              unresolved.push({ index, id: node.broadcaster.id, login: node.broadcaster.login });
            }
          }

          if (unresolved.length > 0) {
            const streams = yield* api.helixStreams([...new Set(unresolved.map((b) => b.id))]).pipe(Effect.option);

            if (Option.isSome(streams)) {
              const streamById = new Map(streams.value.data.map((s) => [s.user_id, s]));

              for (const broadcaster of unresolved) {
                const live = streamById.get(broadcaster.id);
                if (!live) continue;

                const job = chunk[broadcaster.index];
                resolved[broadcaster.index].push(toChannel(job.game, broadcaster.id, broadcaster.login, live.id, live.game_id, live.game_name));
              }
            }
          }

          yield* candidateChannelsCache.setAll(chunk.map((job, index) => [job.key, resolved[index]] as const));
        }
      });

    const getChannelsForCampaign = (campaign: Campaign): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> =>
      Effect.gen(function* () {
        const job = toCandidateJob(campaign);
        if (!job) return [];

        yield* ensureCandidateChannels([campaign]);

        const cached = yield* candidateChannelsCache.get(job.key);
        const candidates = Option.getOrElse(cached, (): ReadonlyArray<Channel> => []);
        if (candidates.length === 0) return [];

        const dropCampaignIds = yield* resolveDropCampaignIds(candidates.map((c) => c.id));
        return candidates.filter((c) => dropCampaignIds.get(c.id)?.has(campaign.id) ?? false).map((c) => ({ ...c, campaignId: campaign.id }));
      });

    const primeCampaignChannels = (campaigns: ReadonlyArray<Campaign>): Effect.Effect<void, TwitchApiError> =>
      Effect.gen(function* () {
        if (campaigns.length === 0) return;

        yield* ensureCandidateChannels(campaigns);

        const channelIds = new Set<string>();
        for (const campaign of campaigns) {
          const job = toCandidateJob(campaign);
          if (!job) continue;

          const cached = yield* candidateChannelsCache.get(job.key);
          if (Option.isNone(cached)) continue;

          for (const channel of cached.value) channelIds.add(channel.id);
        }

        if (channelIds.size > 0) {
          yield* resolveDropCampaignIds([...channelIds]);
        }
      });

    return {
      getMode: Ref.get(modeRef),
      setMode: (mode) => Ref.set(modeRef, mode),
      listCampaigns: Ref.get(campaignsRef).pipe(Effect.map((map) => Array.from(map.values()))),
      getCampaign: (id) => Ref.get(campaignsRef).pipe(Effect.map((map) => Option.fromNullable(map.get(id)))),
      removeCampaign: (id) =>
        Ref.update(campaignsRef, (map) => {
          if (!map.has(id)) return map;
          const next = new Map(map);
          next.delete(id);
          return next;
        }),
      findProgress: (dropId) => Ref.get(progressRef).pipe(Effect.map((drops) => Option.fromNullable(drops.find((d) => d.id === dropId)))),
      updateCampaigns,
      updateProgress,
      claimInventoryDrops,
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
      primeCampaignDetails: (campaignIds) =>
        campaignIds.length === 0
          ? Effect.void
          : configStore.get.pipe(Effect.flatMap((config) => ensureCampaignDetails(campaignIds, config, Date.now()))),
      getChannelsForCampaign,
      primeCampaignChannels,
      addRewards,
    } satisfies CampaignService;
  }),
);
