import { container } from '@vegapunk/core';
import { chalk, strictHas } from '@vegapunk/utilities';
import { isObjectLike, truncate, uniqueId } from '@vegapunk/utilities/common';
import { isErrorLike, Result } from '@vegapunk/utilities/result';

import { Twitch, WsEvents } from '../constants/Enum';
import { writeDebugFile } from '../utils/dev.util';
import { Campaign } from './Campaign';

import type { RequestError } from '@vegapunk/request';
import type { HelixStreams } from '../api/types/HelixStreams';

const CHANNEL_TOPICS = [WsEvents.ChannelMoment, WsEvents.ChannelStream, WsEvents.ChannelUpdate] as const;

export class Channel {
  private static spadeUrl?: string;
  private static settingUrl?: string;

  public readonly id: string;
  public readonly login: string;
  public readonly gameId?: string;

  private hlsUrl?: string;
  private nextWatch: number = 0;
  private isWatchOnce?: boolean;

  public isOnline: boolean = true;
  public currentSid?: string;
  public currentGameId?: string;
  public currentGameName?: string;

  public pointInstanceID?: string;
  public momentInstanceID?: string;

  public constructor(readonly channel: ChannelContext) {
    this.id = channel.id;
    this.login = truncate(channel.login);
    this.gameId = channel.gameId;
  }

  public async listen(id: string = this.id): Promise<void> {
    await Promise.all(CHANNEL_TOPICS.map((topic) => container.ws.listen([topic, id])));
  }

  public async unlisten(id: string = this.id): Promise<void> {
    await Promise.all(CHANNEL_TOPICS.map((topic) => container.ws.unlisten([topic, id])));
  }

  public async watch(): Promise<boolean> {
    if (!this.isOnline) {
      return false;
    }
    if (!this.isWatchOnce) {
      this.isWatchOnce = true;
      Campaign.trackMinutesWatched = 0;
    }
    if (typeof this.gameId === 'string') {
      if (Campaign.trackMinutesWatched === 0) {
        const stream = await this.currentStream();
        if (!strictHas(stream, 'data.0.id')) {
          this.isOnline = false;
          return false;
        }

        const live = stream!.data[0];
        this.currentSid = live.id;
        this.currentGameId = live.game_id;
        this.currentGameName = live.game_name;
      }
      if (this.gameId !== this.currentGameId) {
        this.isOnline = false;
        return false;
      }
    }

    const sendWatch = await Promise.all([this.sendEvent(), this.sendStream()]);
    if (sendWatch.every((result) => !result)) {
      this.isOnline = false;
      return false;
    }
    if (this.nextWatch >= Date.now()) {
      return false;
    }

    Campaign.trackMinutesWatched++;
    return ((this.nextWatch = Date.now() + 60_000), true);
  }

  public async claimPoints(claimID: string = this.pointInstanceID!): Promise<boolean> {
    if (!container.client.config.isClaimPoints || !claimID) {
      return false;
    }

    const res = await container.api.claimPoints({ channelID: this.id, claimID });
    if (!strictHas(res, 'data.claimCommunityPoints')) {
      return false;
    }

    this.pointInstanceID = undefined;
    container.logger.info(chalk`{green ${this.login}} | {yellow Points claimed}`);
    return true;
  }

  public async claimMoments(momentID: string = this.momentInstanceID!): Promise<boolean> {
    if (!container.client.config.isClaimMoments || !momentID) {
      return false;
    }

    const res = await container.api.claimMoments(momentID);
    await writeDebugFile(res, uniqueId('claimMoments'));

    this.momentInstanceID = undefined;
    container.logger.info(chalk`{green ${this.login}} | {yellow Moments claimed}`);
    return true;
  }

  private async currentStream(): Promise<HelixStreams | null> {
    const result = await Result.fromAsync(async () => {
      const { body } = await container.api.request<HelixStreams>({
        url: 'https://api.twitch.tv/helix/streams',
        headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
        searchParams: { user_id: this.id },
        responseType: 'json',
      });
      return body;
    });
    if (result.isErr()) {
      container.logger.error(result.unwrapErr(), `Could not fetch stream ${this.id}`);
      return null;
    }
    return result.unwrap();
  }

  private async sendEvent(): Promise<boolean> {
    const result = await Result.fromAsync(async () => {
      if (typeof Channel.settingUrl !== 'string') {
        const { body } = await container.api.request({ url: Twitch.WebUrl });
        const settingsReg = new RegExp(Twitch.SettingReg);
        Channel.settingUrl = settingsReg.exec(body)?.[0];
        if (!Channel.settingUrl) {
          return Result.err(new Error('Could not parsing Settings Url'));
        }
      }

      if (typeof Channel.spadeUrl !== 'string') {
        const { body } = await container.api.request({ url: Channel.settingUrl });
        const spadeReg = new RegExp(Twitch.SpadeReg);
        Channel.spadeUrl = spadeReg.exec(body)?.[0];
        if (!Channel.spadeUrl) {
          return Result.err(new Error('Could not parsing Spade Url'));
        }
      }

      const payload = {
        event: 'minute-watched',
        properties: {
          hidden: false,
          live: true,
          location: 'channel',
          logged_in: true,
          muted: false,
          player: 'site',
          channel: this.login,
          channel_id: this.id,
          broadcast_id: this.currentSid,
          user_id: container.api.userId,
          game: this.currentGameName ?? undefined,
          game_id: this.currentGameId ?? undefined,
        },
      };

      const json_event = JSON.stringify([payload]);
      const base64_event = Buffer.from(json_event).toString('base64');
      const watch = await container.api.request({ method: 'POST', url: Channel.spadeUrl, body: base64_event });
      return watch.statusCode === 204;
    });
    if (result.isErr()) {
      container.logger.error(result.unwrapErr(), `Could not send event ${this.login}`);
      return false;
    }
    return true;
  }

  private async sendStream(): Promise<boolean> {
    const result = await Result.fromAsync(async () => {
      if (!this.hlsUrl) {
        const playback = await container.api.playbackToken(this.login);
        const token = playback.data.streamPlaybackAccessToken;

        const hls = await container.api.request({
          url: `https://usher.ttvnw.net/api/channel/hls/${this.login}.m3u8`,
          searchParams: { sig: token.signature, token: token.value },
        });
        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        this.hlsUrl = hlsFilter.find((url) => url.startsWith('http'));
      }

      const hls = await container.api.request({ url: this.hlsUrl });
      const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
      const hlsUrl = hlsFilter.find((url) => url.startsWith('http'));

      const stream = await container.api.request({ method: 'HEAD', url: hlsUrl });
      return stream.statusCode === 200;
    });
    if (result.isErr()) {
      const error = result.unwrapErr();
      if (isErrorLike<RequestError>(error) && isObjectLike(error.response)) {
        if (error.response.statusCode === 404) {
          const channel = await container.api.channelLive(this.login);
          if (!strictHas(channel, 'data.user.stream.id')) {
            return false;
          }

          this.hlsUrl = undefined;
          return this.sendStream();
        }
      }

      container.logger.error(error, `Could not watch stream ${this.login}`);
      return false;
    }
    return true;
  }
}

export interface ChannelContext {
  readonly id: string;
  readonly login: string;
  readonly gameId?: string;
}
