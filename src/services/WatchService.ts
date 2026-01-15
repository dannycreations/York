import { Context, Data, Effect, Layer, Ref } from 'effect';

import { Channel } from '../core/Types';
import { HttpClientTag } from '../structures/HttpClient';
import { GqlQueries, TwitchApiTag } from './TwitchApi';

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

export const WatchServiceLayer = Layer.effect(
  WatchServiceTag,
  Effect.gen(function* () {
    const http = yield* HttpClientTag;
    const api = yield* TwitchApiTag;

    const settingUrlRef = yield* Ref.make<string | undefined>(undefined);
    const spadeUrlRef = yield* Ref.make<string | undefined>(undefined);

    const getSpadeUrl = Effect.gen(function* () {
      const spadeUrl = yield* Ref.get(spadeUrlRef);
      if (spadeUrl) return spadeUrl;

      let settingUrl = yield* Ref.get(settingUrlRef);
      if (!settingUrl) {
        const webRes = yield* http.request({ url: 'https://www.twitch.tv' });
        const match = webRes.body.match(/https:\/\/(static\.twitchcdn\.net|assets\.twitch\.tv)\/config\/settings\.[0-9a-f]{32}\.js/);
        if (!match) return yield* Effect.fail(new WatchError({ message: 'Could not parse Settings URL' }));
        settingUrl = match[0];
        yield* Ref.set(settingUrlRef, settingUrl);
      }

      const settingRes = yield* http.request({ url: settingUrl });
      const spadeMatch = settingRes.body.match(/https:\/\/video-edge-[.\w\-/]+\.ts/);
      if (!spadeMatch) return yield* Effect.fail(new WatchError({ message: 'Could not parse Spade URL' }));

      const foundSpadeUrl = spadeMatch[0];
      yield* Ref.set(spadeUrlRef, foundSpadeUrl);
      return foundSpadeUrl;
    });

    const watch = (channel: Channel) =>
      Effect.gen(function* () {
        const spadeUrl = yield* getSpadeUrl;
        const userId = yield* api.userId;

        if (!channel.currentSid) return { success: false };

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

          const body = Buffer.from(JSON.stringify([payload])).toString('base64');
          const res = yield* http.request({
            method: 'POST',
            url: spadeUrl,
            body,
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
            // Parity with Channel.ts:208 - handle 404 by checking if still live and refreshing HLS
            const live = yield* api.channelLive(channel.login);
            if (!live.data?.user?.stream?.id) return false;

            currentHlsUrl = yield* getHlsUrl(channel.login);
            return yield* checkStream(currentHlsUrl);
          }
          return success;
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));

        const [eventSuccess, streamSuccess] = yield* Effect.all([sendEvent, sendStream], { concurrency: 'unbounded' });
        return {
          success: eventSuccess || streamSuccess,
          hlsUrl: currentHlsUrl,
        };
      }).pipe(Effect.catchAll(() => Effect.succeed({ success: false })));

    const getHlsUrl = (login: string) =>
      Effect.gen(function* () {
        const playback = yield* api.graphql<any>(GqlQueries.playbackToken(login));
        const token = playback[0].data.streamPlaybackAccessToken;
        const hls = yield* http.request({
          url: `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`,
          searchParams: { sig: token.signature, token: token.value },
        });

        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        const found = hlsFilter.find((url) => url.startsWith('http'));
        if (!found) return yield* Effect.fail(new WatchError({ message: 'HLS URL not found' }));
        return found;
      }).pipe(Effect.catchAll((e) => Effect.fail(new WatchError({ message: 'Failed to get HLS URL', cause: e }))));

    const checkStream = (hlsUrl: string) =>
      Effect.gen(function* () {
        const hls = yield* http.request({ url: hlsUrl });
        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        const chunkUrl = hlsFilter.find((url) => url.startsWith('http'));
        if (!chunkUrl) return false;

        const res = yield* http.request({ method: 'HEAD', url: chunkUrl });
        if (res.statusCode === 404) {
          // Parity with Channel.ts:208 - handle 404 by clearing HLS URL
          return false;
        }
        return res.statusCode === 200;
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    return { watch, getHlsUrl, checkStream };
  }),
);
