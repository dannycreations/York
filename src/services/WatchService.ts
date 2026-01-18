import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { Twitch } from '../core/Constants';
import { PlaybackTokenSchema } from '../core/Schemas';
import { HttpClientTag } from '../structures/HttpClient';
import { TwitchApiTag } from './TwitchApi';
import { GqlQueries } from './TwitchQueries';

import type { Channel } from '../core/Schemas';
import type { HttpClient } from '../structures/HttpClient';
import type { TwitchApi } from './TwitchApi';

export class WatchError extends Data.TaggedError('WatchError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface WatchService {
  readonly watch: (channel: Channel) => Effect.Effect<{ success: boolean; hlsUrl?: string }, WatchError>;
  readonly getHlsUrl: (login: string) => Effect.Effect<string, WatchError>;
  readonly checkStream: (hlsUrl: string) => Effect.Effect<boolean, WatchError>;
}

export const WatchServiceTag = Context.GenericTag<WatchService>('@services/WatchService');

export const WatchServiceLayer: Layer.Layer<WatchService, never, HttpClient | TwitchApi> = Layer.effect(
  WatchServiceTag,
  Effect.gen(function* () {
    const http = yield* HttpClientTag;
    const api = yield* TwitchApiTag;

    const settingUrlRef = yield* Ref.make<Option.Option<string>>(Option.none());
    const spadeUrlRef = yield* Ref.make<Option.Option<string>>(Option.none());

    const fetchRegexUrl = (
      url: string,
      regex: RegExp,
      cache: Ref.Ref<Option.Option<string>>,
      errorMessage: string,
    ): Effect.Effect<string, WatchError> =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(cache);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const response = yield* http.request({ url }).pipe(Effect.mapError((e) => new WatchError({ message: 'Failed to fetch URL', cause: e })));
        const match = response.body.match(regex);

        if (match && match[0]) {
          yield* Ref.set(cache, Option.some(match[0]));
          return match[0];
        }

        return yield* Effect.fail(new WatchError({ message: errorMessage }));
      });

    const getSettingUrl = fetchRegexUrl(Twitch.WebUrl, Twitch.SettingReg, settingUrlRef, 'Could not parse Settings URL');

    const getSpadeUrl = Effect.gen(function* () {
      const settingUrl = yield* getSettingUrl;
      return yield* fetchRegexUrl(settingUrl, Twitch.SpadeReg, spadeUrlRef, 'Could not parse Spade URL');
    });

    const watch = (channel: Channel): Effect.Effect<{ success: boolean; hlsUrl?: string }, WatchError> =>
      Effect.gen(function* () {
        const spadeUrl = yield* getSpadeUrl;
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

        const [eventSuccess, streamSuccess] = yield* Effect.all([sendEvent, sendStream]);

        return {
          success: eventSuccess || streamSuccess,
          hlsUrl: currentHlsUrl,
        };
      }).pipe(Effect.catchAll(() => Effect.succeed({ success: false })));

    const getHlsUrl = (login: string): Effect.Effect<string, WatchError> =>
      Effect.gen(function* () {
        const playback = yield* api.graphql(GqlQueries.playbackToken(login), PlaybackTokenSchema);
        const token = playback[0].streamPlaybackAccessToken;
        const hls = yield* http.request({
          url: `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`,
          searchParams: { sig: token.signature, token: token.value },
        });

        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        const found = hlsFilter.find((url) => url.startsWith('http'));
        if (found) {
          return found;
        }

        return yield* Effect.fail(new WatchError({ message: 'HLS URL not found' }));
      }).pipe(Effect.mapError((e) => (e instanceof WatchError ? e : new WatchError({ message: 'Failed to get HLS URL', cause: e }))));

    const checkStream = (hlsUrl: string): Effect.Effect<boolean, WatchError> =>
      Effect.gen(function* () {
        const hls = yield* http.request({ url: hlsUrl });
        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        const chunkUrl = hlsFilter.find((url) => url.startsWith('http'));
        if (!chunkUrl) {
          return false;
        }

        const res = yield* http.request({ method: 'HEAD', url: chunkUrl });
        return res.statusCode === 200;
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    return {
      watch,
      getHlsUrl,
      checkStream,
    };
  }),
);
