import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { Twitch } from '../core/Constants';
import { PlaybackTokenSchema } from '../core/Schemas';
import { HttpClientTag } from '../structures/HttpClient';
import { TwitchApiTag } from './TwitchApi';
import { GqlQueries } from './TwitchQueries';

import type { Channel } from '../core/Schemas';

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

    const fetchRegexUrl = (
      url: string,
      regex: RegExp,
      cache: Ref.Ref<Option.Option<string>>,
      errorMessage: string,
    ): Effect.Effect<string, WatchError> =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(cache);
        if (Option.isSome(cached)) return cached.value;

        const response = yield* http.request({ url }).pipe(Effect.mapError((e) => new WatchError({ message: 'Failed to fetch URL', cause: e })));

        const match = response.body.match(regex);
        if (match && match[0]) {
          const result = match[0];
          yield* Ref.set(cache, Option.some(result));
          return result;
        }

        return yield* Effect.fail(new WatchError({ message: errorMessage }));
      });

    const getSettingUrl = () => fetchRegexUrl(Twitch.WebUrl, Twitch.SettingReg, settingUrlRef, 'Could not parse Settings URL');

    const getSpadeUrl = () =>
      Effect.gen(function* () {
        const settingUrl = yield* getSettingUrl();
        return yield* fetchRegexUrl(settingUrl, Twitch.SpadeReg, spadeUrlRef, 'Could not parse Spade URL');
      });

    const watch = (channel: Channel): Effect.Effect<{ readonly success: boolean; readonly hlsUrl?: string }, WatchError> =>
      Effect.gen(function* () {
        if (!channel.currentSid) return { success: false };

        const spadeUrl = yield* getSpadeUrl();
        const userId = yield* api.userId;

        const sendEvent = Effect.gen(function* () {
          const body = JSON.stringify([
            {
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
            },
          ]);

          const response = yield* http.request({
            method: 'POST',
            url: spadeUrl,
            body: Buffer.from(body).toString('base64'),
          });

          return response.statusCode === 204;
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));

        const sendStream = Effect.gen(function* () {
          const hlsUrl = channel.hlsUrl ? channel.hlsUrl : yield* getHlsUrl(channel.login);
          const success = yield* checkStream(hlsUrl);
          if (success) return { success: true, hlsUrl };

          const live = yield* api.channelLive(channel.login);
          if (!live.user?.stream?.id) return { success: false, hlsUrl };

          const freshHlsUrl = yield* getHlsUrl(channel.login);
          const freshSuccess = yield* checkStream(freshHlsUrl);
          return { success: freshSuccess, hlsUrl: freshHlsUrl };
        }).pipe(Effect.catchAll(() => Effect.succeed({ success: false, hlsUrl: channel.hlsUrl })));

        const [eventSuccess, streamResult] = yield* Effect.all([sendEvent, sendStream]);

        return {
          success: eventSuccess || streamResult.success,
          hlsUrl: streamResult.hlsUrl,
        };
      }).pipe(Effect.catchAll(() => Effect.succeed({ success: false })));

    const findLastHttpUrl = (text: string): string | undefined => {
      const start = text.lastIndexOf('\nhttp') + 1;
      if (start === 0) return text.startsWith('http') ? text.split('\n', 1)[0].trim() : undefined;
      const end = text.indexOf('\n', start);
      return (end === -1 ? text.substring(start) : text.substring(start, end)).trim();
    };

    const getHlsUrl = (login: string): Effect.Effect<string, WatchError> =>
      Effect.gen(function* () {
        const playback = yield* api.graphql(GqlQueries.playbackToken(login), PlaybackTokenSchema);
        const token = playback[0].streamPlaybackAccessToken;

        const hls = yield* http.request({
          url: `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`,
          searchParams: { sig: token.signature, token: token.value },
          headers: { accept: 'application/x-mpegURL' },
        });

        const url = findLastHttpUrl(hls.body);
        if (!url) {
          return yield* Effect.fail(new WatchError({ message: 'HLS URL not found' }));
        }

        return url;
      }).pipe(Effect.mapError((e) => (e instanceof WatchError ? e : new WatchError({ message: 'Failed to get HLS URL', cause: e }))));

    const checkStream = (hlsUrl: string): Effect.Effect<boolean, WatchError> =>
      Effect.gen(function* () {
        const hls = yield* http.request({ url: hlsUrl, headers: { accept: 'application/x-mpegURL' } });
        const chunkUrl = findLastHttpUrl(hls.body);
        if (!chunkUrl) return false;

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
