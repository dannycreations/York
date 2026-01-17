import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { PlaybackTokenSchema } from '../core/Types';
import { HttpClientTag } from '../structures/HttpClient';
import { GqlQueries, TwitchApiTag } from './TwitchApi';

import type { Channel } from '../core/Types';

export class WatchError extends Data.TaggedError('WatchError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface WatchService {
  readonly watch: (channel: Channel) => Effect.Effect<{ success: boolean; hlsUrl?: string }, WatchError>;
  readonly getHlsUrl: (login: string) => Effect.Effect<string, WatchError>;
  readonly checkStream: (hlsUrl: string) => Effect.Effect<boolean, WatchError>;
}

export class WatchServiceTag extends Context.Tag('@services/WatchService')<WatchServiceTag, WatchService>() {}

export const WatchServiceLayer: Layer.Layer<WatchServiceTag, never, HttpClientTag | TwitchApiTag> = Layer.effect(
  WatchServiceTag,
  Effect.gen(function* () {
    const http = yield* HttpClientTag;
    const api = yield* TwitchApiTag;

    const settingUrlRef = yield* Ref.make<Option.Option<string>>(Option.none());
    const spadeUrlRef = yield* Ref.make<Option.Option<string>>(Option.none());

    const getSpadeUrl = (): Effect.Effect<string, WatchError> =>
      Effect.gen(function* () {
        const spadeUrl = yield* Ref.get(spadeUrlRef);
        if (Option.isSome(spadeUrl)) {
          return spadeUrl.value;
        }

        let settingUrl = yield* Ref.get(settingUrlRef);
        if (Option.isNone(settingUrl)) {
          const webRes = yield* http
            .request({ url: 'https://www.twitch.tv' })
            .pipe(Effect.mapError((e) => new WatchError({ message: 'Failed to fetch Twitch home', cause: e })));
          const match = webRes.body.match(/https:\/\/(static\.twitchcdn\.net|assets\.twitch\.tv)\/config\/settings\.[0-9a-f]{32}\.js/);
          if (match && match[0]) {
            const foundSettingUrl = match[0];
            yield* Ref.set(settingUrlRef, Option.some(foundSettingUrl));
            settingUrl = Option.some(foundSettingUrl);
          } else {
            return yield* Effect.fail(new WatchError({ message: 'Could not parse Settings URL' }));
          }
        }

        const settingRes = yield* http
          .request({ url: Option.getOrThrow(settingUrl) })
          .pipe(Effect.mapError((e) => new WatchError({ message: 'Failed to fetch settings', cause: e })));
        const spadeMatch = settingRes.body.match(/https:\/\/video-edge-[.\w\-/]+\.ts/);
        if (!spadeMatch || !spadeMatch[0]) {
          return yield* Effect.fail(new WatchError({ message: 'Could not parse Spade URL' }));
        }

        const foundSpadeUrl = spadeMatch[0];
        yield* Ref.set(spadeUrlRef, Option.some(foundSpadeUrl));
        return foundSpadeUrl;
      });

    const watch = (channel: Channel): Effect.Effect<{ success: boolean; hlsUrl?: string }, WatchError> =>
      Effect.gen(function* () {
        const spadeUrl = yield* getSpadeUrl();
        const userId = yield* api.userId;

        if (!channel.currentSid) {
          return { success: false };
        }

        const sendEvent = Effect.gen(function* () {
          const payload = {
            event: 'minute-watched',
            properties: {
              hidden: false,
              live: true,
              location: 'channel',
              logged_in: true,
              muted: false,
              player: 'site',
              channel: channel.login,
              channel_id: channel.id,
              broadcast_id: channel.currentSid,
              user_id: userId,
              game: channel.currentGameName,
              game_id: channel.currentGameId,
            },
          };

          const res = yield* http.request({
            method: 'POST',
            url: spadeUrl,
            body: Buffer.from(JSON.stringify([payload])).toString('base64'),
          });

          return res.statusCode === 204;
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));

        let currentHlsUrl = channel.hlsUrl;
        const sendStream = Effect.gen(function* () {
          if (!currentHlsUrl) {
            currentHlsUrl = yield* getHlsUrl(channel.login);
          }
          const success = yield* checkStream(currentHlsUrl);
          if (!success) {
            const live = yield* api.channelLive(channel.login);
            if (!live.user?.stream?.id) {
              return false;
            }

            currentHlsUrl = yield* getHlsUrl(channel.login);
            return yield* checkStream(currentHlsUrl);
          }
          return success;
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));

        const [eventSuccess, streamSuccess] = yield* Effect.all([sendEvent, sendStream], { concurrency: 2 }).pipe(
          Effect.annotateLogs({ service: 'WatchService', channel: channel.login }),
        );
        return {
          success: eventSuccess && streamSuccess,
          hlsUrl: currentHlsUrl,
        };
      }).pipe(Effect.catchAll(() => Effect.succeed({ success: false })));

    const getHlsUrl = (login: string) =>
      Effect.gen(function* () {
        const playback = yield* api.graphql(GqlQueries.playbackToken(login), PlaybackTokenSchema);
        const token = playback[0].streamPlaybackAccessToken;
        const hls = yield* http.request({
          url: `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`,
          searchParams: { sig: token.signature, token: token.value },
        });

        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        const found = hlsFilter.find((url) => url.startsWith('http'));
        if (!found) {
          return yield* Effect.fail(new WatchError({ message: 'HLS URL not found' }));
        }
        return found;
      }).pipe(Effect.catchAll((e) => Effect.fail(new WatchError({ message: 'Failed to get HLS URL', cause: e }))));

    const checkStream = (hlsUrl: string) =>
      Effect.gen(function* () {
        const hls = yield* http.request({ url: hlsUrl });
        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        const chunkUrl = hlsFilter.find((url) => url.startsWith('http'));
        if (!chunkUrl) {
          return false;
        }

        const res = yield* http.request({ method: 'HEAD', url: chunkUrl });
        if (res.statusCode === 404) {
          return false;
        }
        return res.statusCode === 200;
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    return { watch, getHlsUrl, checkStream };
  }),
);
