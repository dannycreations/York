import { container } from '@vegapunk/core';
import { WebSocket, WebSocketState } from '@vegapunk/struct';
import { randomString } from '@vegapunk/utilities';
import { attempt } from '@vegapunk/utilities/common';

import { Twitch } from '../constants/Enum';
import { RequestTopic, RequestType, ResponseContent, ResponseMessage, ResponseTopic, ResponseType } from './types/WebSocket';

import type { ClientEvents } from '@vegapunk/core';
import type { WsEvents } from '../constants/Enum';

export class AppSocket extends WebSocket<Required<WebSocketOptions>> {
  private readonly subscribedTopics: Map<string, RequestTopic> = new Map();
  private lastPongReceivedAt: number = 0;

  public constructor(authToken: string) {
    super({
      authToken,
      url: Twitch.WssUrl,
      autoConnect: false,
      pingIntervalMs: 180_000,
      requestTimeoutMs: 10_000,
      logger: container.logger.debug.bind(container.logger),
    });
  }

  public async listen(topicKey: RequestTopicKey): Promise<void> {
    const topicName = this.parseTopicKey(topicKey);
    if (this.subscribedTopics.has(topicName)) {
      this.options.logger(`AppSocket: Already subscribing ${topicName}`);
      return;
    }

    const request: RequestTopic = {
      type: RequestType.Listen,
      nonce: randomString(30),
      data: {
        topics: [topicName],
        auth_token: this.options.authToken,
      },
    };

    await this.sendRequestAndWait(request);
    this.subscribedTopics.set(topicName, request);
    this.options.logger(`AppSocket: Subscribed ${topicName}`);
  }

  public async unlisten(topicKey: RequestTopicKey): Promise<void> {
    const topicName = this.parseTopicKey(topicKey);
    if (!this.subscribedTopics.has(topicName)) {
      this.options.logger(`AppSocket: Not currently subscribing ${topicName}`);
      return;
    }

    const request: RequestTopic = {
      type: RequestType.Unlisten,
      nonce: randomString(30),
      data: {
        topics: [topicName],
        auth_token: this.options.authToken,
      },
    };

    await this.sendRequestAndWait(request);
    this.subscribedTopics.delete(topicName);
    this.options.logger(`AppSocket: Unsubscribed ${topicName}`);
  }

  public override dispose(): void {
    if (this.isDisposed) {
      return;
    }

    super.dispose();
    this.subscribedTopics.clear();
    this.options.logger('AppSocket: Disposed');
  }

  protected override async onOpen(): Promise<void> {
    this.lastPongReceivedAt = Date.now();
    await this.resubscribeToAllTopics();
  }

  protected override onMessage(data: Buffer): void {
    const [error, message] = attempt<ResponseTopic, null>(() => JSON.parse(data.toString('utf8')));
    if (error) {
      this.options.logger({ data }, 'AppSocket: Failed to parse message JSON');
      return;
    }

    if (typeof message?.type !== 'string') {
      this.options.logger({ message }, 'AppSocket: Received malformed message');
      return;
    }

    switch (message.type) {
      case ResponseType.Pong:
        this.lastPongReceivedAt = Date.now();
        this.options.logger('AppSocket: PONG received');
        break;

      case ResponseType.Response:
        if (typeof message.nonce !== 'string') {
          this.options.logger({ message }, 'AppSocket: Received RESPONSE without nonce');
        } else if (!this.subscribedTopics.values().some((r) => r.nonce === message.nonce)) {
          this.options.logger({ message }, 'AppSocket: Received RESPONSE with unknown nonce');
        } else if (message.error && message.error !== '') {
          this.options.logger({ message }, 'AppSocket: Received RESPONSE with error');
        }
        break;

      case ResponseType.Message:
        const { data: eventData } = message as unknown as ResponseMessage;
        if (!eventData || typeof eventData.topic !== 'string' || typeof eventData.message !== 'string') {
          this.options.logger({ message }, 'AppSocket: Received MESSAGE with unknown shape');
          return;
        }

        const [errorContent, content] = attempt<Record<string, unknown>, null>(() => JSON.parse(eventData.message));
        if (errorContent) {
          this.options.logger({ message }, 'AppSocket: Failed to parse content JSON');
          return;
        }

        const [topicType, topicId] = eventData.topic.split('.');
        const eventContent = { topic_id: topicId, ...content } as ResponseContent;
        container.client.emit(topicType as keyof ClientEvents, eventContent);
        this.options.logger(eventContent, `AppSocket: Emitted ${eventData.topic}`);
        break;

      case ResponseType.Reconnect:
        this.options.logger('AppSocket: Received RECONNECT instruction from server');
        super.disconnect(false);
        break;

      default:
        this.options.logger({ message }, 'AppSocket: Received UNKNOWN message type');
    }
  }

  protected override async onPing(): Promise<void> {
    const pongDeadline = this.lastPongReceivedAt + this.options.pingIntervalMs + this.options.requestTimeoutMs;
    if (Date.now() > pongDeadline) {
      this.options.logger(
        {
          last: new Date(this.lastPongReceivedAt).toISOString(),
          deadline: new Date(pongDeadline).toISOString(),
        },
        'AppSocket: Ping health check failed. Forcing reconnect',
      );
      super.disconnect(false);
      return;
    }

    await super.sendRequest({
      description: 'ping',
      payload: JSON.stringify({ type: RequestType.Ping }),
    });
    this.options.logger('AppSocket: PING sent');
  }

  protected override onClose(error: Error): void {
    this.options.logger(error);
  }

  protected override onError(error: Error): void {
    this.options.logger(error);
  }

  protected override onMaxReconnects(): void {
    const eventError = new Error('AppSocket: Max reconnect attempts reached');
    this.options.logger(eventError, eventError.message);
  }

  private async sendRequestAndWait(payload: RequestTopic): Promise<void> {
    this.options.logger(
      {
        topic: payload.data.topics.join(', '),
        nonce: payload.nonce,
      },
      `AppSocket: Sending ${payload.type} request`,
    );

    return super.sendRequest({
      description: `${payload.type} (nonce ${payload.nonce})`,
      payload: JSON.stringify(payload),
    });
  }

  private async resubscribeToAllTopics(): Promise<void> {
    if (this.isDisposed || this.state !== WebSocketState.OPEN || this.subscribedTopics.size === 0) {
      return;
    }

    const currentSubscribedTopics = [...this.subscribedTopics.values()];
    this.subscribedTopics.clear();

    this.options.logger(`AppSocket: Attempting to resubscribe to ${currentSubscribedTopics.length} topics`);
    await Promise.allSettled(currentSubscribedTopics.map((req) => this.listen(req.data.topics[0])));
    this.options.logger('AppSocket: Finished processing topic resubscriptions');
  }

  private parseTopicKey(topicKey: RequestTopicKey): string {
    return typeof topicKey === 'string' ? topicKey : topicKey.join('.');
  }
}

interface WebSocketOptions {
  readonly authToken?: string;
}

type RequestTopicKey = readonly [`${WsEvents}`, string] | string;
