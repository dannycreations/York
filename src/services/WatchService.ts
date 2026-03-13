import { Context, Data, Effect, Layer } from 'effect';

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

    const watch = (channel: Channel): Effect.Effect<{ readonly success: boolean; readonly hlsUrl?: string }, WatchError> =>
      Effect.gen(function* () {
        const hasNoSid = !channel.currentSid;

        if (hasNoSid) {
          return { success: false };
        }

        const sendStream = Effect.gen(function* () {
          const initialHlsUrl = channel.hlsUrl || (yield* getHlsUrl(channel.login));
          const isInitialSuccess = yield* checkStream(initialHlsUrl);

          if (isInitialSuccess) {
            return { success: true, hlsUrl: initialHlsUrl };
          }

          const live = yield* api.channelLive(channel.login);
          const streamId = live.user?.stream?.id;

          if (!streamId) {
            return { success: false, hlsUrl: initialHlsUrl };
          }

          const freshHlsUrl = yield* getHlsUrl(channel.login);
          const isFreshSuccess = yield* checkStream(freshHlsUrl);

          return { success: isFreshSuccess, hlsUrl: freshHlsUrl };
        }).pipe(Effect.catchAll(() => Effect.succeed({ success: false, hlsUrl: channel.hlsUrl })));

        const streamResult = yield* sendStream;

        return {
          success: streamResult.success,
          hlsUrl: streamResult.hlsUrl,
        };
      }).pipe(Effect.catchAll(() => Effect.succeed({ success: false })));

    const findLastHttpUrl = (text: string): string | undefined => {
      const start = text.lastIndexOf('\nhttp') + 1;
      if (start === 0) {
        const hasHttp = text.startsWith('http');

        if (!hasHttp) {
          return undefined;
        }

        const lines = text.split('\n', 1);
        return lines[0].trim();
      }

      const end = text.indexOf('\n', start);

      if (end === -1) {
        return text.substring(start).trim();
      }

      return text.substring(start, end).trim();
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
