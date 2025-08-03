import { container } from '@vegapunk/core';
import { type RequestError } from '@vegapunk/request';
import { chalk, strictHas } from '@vegapunk/utilities';
import { isObjectLike, truncate, uniqueId } from '@vegapunk/utilities/common';
import { isErrorLike, Result } from '@vegapunk/utilities/result';

import { type HelixStreams } from '../api/types/HelixStreams';
import { WsEvents } from '../constants/Enum';
import { writeDebugFile } from '../utils/dev.util';
import { Campaign } from './Campaign';

export class Channel {
  public readonly id: string;
  public readonly login: string;
  public readonly gameId?: string;

  public isOnline: boolean = true;
  public currentGameId?: string;

  public constructor(channel: ChannelContext) {
    this.id = channel.id;
    this.login = truncate(channel.login);
    this.gameId = channel.gameId;
  }

  public async listen(id: string = this.id): Promise<void> {
    await Promise.all(this.topics.map((r) => container.ws.listen([r, id])));
  }

  public async unlisten(id: string = this.id): Promise<void> {
    await Promise.all(this.topics.map((r) => container.ws.unlisten([r, id])));
  }

  private isWatchOnce?: boolean;
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

        this.currentGameId = stream!.data[0].game_id;
      }
      if (this.gameId !== this.currentGameId) {
        this.isOnline = false;
        return false;
      }
    }
    if (!(await this.stream())) {
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
    container.logger.info(chalk`{green ${this.login}} | {yellow Points claimed}.`);
    return true;
  }

  public async claimMoments(momentID: string = this.momentInstanceID!): Promise<boolean> {
    if (!container.client.config.isClaimMoments || !momentID) {
      return false;
    }

    const res = await container.api.claimMoments(momentID);
    await writeDebugFile(res, uniqueId('claimMoments'));

    this.momentInstanceID = undefined;
    container.logger.info(chalk`{green ${this.login}} | {yellow Moments claimed}.`);
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
      const error = result.unwrapErr();
      container.logger.error(error, `Could not fetch stream ${this.id}.`);
      return null;
    }
    return result.unwrap();
  }

  private async stream(): Promise<boolean> {
    const result = await Result.fromAsync(async () => {
      if (!this.hlsUrl) {
        const playback = await container.api.playbackToken(this.login);
        const token = playback.data.streamPlaybackAccessToken;

        const hls = await container.api.request({
          url: `https://usher.ttvnw.net/api/channel/hls/${this.login}.m3u8`,
          searchParams: { sig: token.signature, token: token.value },
        });
        const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
        this.hlsUrl = hlsFilter.find((r) => r.startsWith('http'));
      }

      const hls = await container.api.request({ url: this.hlsUrl });
      const hlsFilter = hls.body.split('\n').filter(Boolean).reverse();
      const hlsUrl = hlsFilter.find((r) => r.startsWith('http'));

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
          return this.stream();
        }
      }

      container.logger.error(error, `Could not watch stream ${this.login}.`);
      return false;
    }
    return true;
  }

  private nextWatch: number = 0;
  private hlsUrl?: string;
  private pointInstanceID?: string;
  private momentInstanceID?: string;

  private readonly topics: WsEvents[] = [WsEvents.ChannelMoment, WsEvents.ChannelStream, WsEvents.ChannelUpdate];
}

export interface ChannelContext {
  id: string;
  login: string;
  gameId?: string;
}
