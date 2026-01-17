import { WebSocket as ws } from 'ws';

import type { ValueOf } from '@vegapunk/utilities';
import type { ClientRequestArgs } from 'node:http';
import type { ClientOptions, CloseEvent, ErrorEvent } from 'ws';

export const WebSocketState = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  RECONNECTING: 'RECONNECTING',
} as const;

const PING_INTERVAL_MS: number = 30_000;
const REQUEST_RETRY_MS: number = 1_000;
const REQUEST_TIMEOUT_MS: number = 10_000;
const REQUEST_MAX_ATTEMPTS: number = 3;
const RECONNECT_BASE_MS: number = 1_000;
const RECONNECT_MAX_MS: number = 60_000;
const RECONNECT_MAX_ATTEMPTS: number = Infinity;
const BUFFERED_THRESHOLD_AMOUNT: number = 1_048_576;
const GRACEFUL_DISCONNECT_CODE: number = 1000;

export interface WebSocketOptions {
  readonly url: string;
  readonly autoConnect?: boolean;
  readonly pingIntervalMs?: number;
  readonly requestRetryMs?: number;
  readonly requestTimeoutMs?: number;
  readonly requestMaxAttempts?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly reconnectMaxAttempts?: number;
  readonly bufferedThresholdAmount?: number;
  readonly socketOptions?: ClientOptions | ClientRequestArgs;
  readonly logger?: (...args: unknown[]) => void;
}

interface RequestPromise {
  readonly description: string;
  readonly payload: unknown;
  readonly callback?: (error: unknown) => boolean;

  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;

  attempts: number;
  timeoutId?: NodeJS.Timeout;
}

export abstract class WebSocket<UserOptions extends object = object> {
  protected readonly options: Required<WebSocketOptions> & UserOptions;

  protected ws?: ws;
  protected state: ValueOf<typeof WebSocketState> = WebSocketState.IDLE;
  protected isDisposed: boolean = false;

  private pingTimeoutId?: NodeJS.Timeout;
  private reconnectAttempts: number = 0;
  private reconnectTimeoutId?: NodeJS.Timeout;
  private isRequestActive: boolean = false;
  private readonly requestQueue: RequestPromise[] = [];

  public constructor(options: WebSocketOptions & UserOptions) {
    this.options = {
      autoConnect: true,
      pingIntervalMs: PING_INTERVAL_MS,
      requestRetryMs: REQUEST_RETRY_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      requestMaxAttempts: REQUEST_MAX_ATTEMPTS,
      reconnectBaseMs: RECONNECT_BASE_MS,
      reconnectMaxMs: RECONNECT_MAX_MS,
      reconnectMaxAttempts: RECONNECT_MAX_ATTEMPTS,
      bufferedThresholdAmount: BUFFERED_THRESHOLD_AMOUNT,
      socketOptions: {},
      logger: () => {},
      ...options,
    };

    if (this.options.autoConnect) {
      this.connect();
    }
  }

  protected abstract onOpen(): unknown;
  protected abstract onMessage(data: unknown): unknown;
  protected abstract onPing(): unknown;
  protected abstract onClose(error: unknown): unknown;
  protected abstract onError(error: unknown): unknown;
  protected abstract onMaxReconnects(): unknown;

  public connect(): void {
    if (this.isDisposed || this.state === WebSocketState.CONNECTING || this.state === WebSocketState.OPEN) {
      return;
    }

    this.state = WebSocketState.CONNECTING;
    this.options.logger(`WebSocket: Connecting to ${this.options.url}`);

    try {
      const newWs = new ws(this.options.url, this.options.socketOptions);
      newWs.once('open', this.handleOpen.bind(this));
      newWs.once('close', this.handleClose.bind(this));
      newWs.on('error', this.handleError.bind(this));
      newWs.on('message', this.handleMessage.bind(this));
      this.ws = newWs;
    } catch (error: unknown) {
      const connectError = new Error(`WebSocket: Connection attempt to ${this.options.url} failed`);
      Object.assign(connectError, { error });
      Promise.resolve(this.onError(connectError))
        .then(() => {
          this.disconnect(false);
        })
        .catch((error: unknown) => {
          this.options.logger(error, 'WebSocket: Error during onError connect handler');
        });
    }
  }

  public disconnect(graceful: boolean = false): void {
    if (!this.ws || this.state === WebSocketState.CLOSED) {
      return;
    }

    this.options.logger(`WebSocket: Disconnecting (graceful: ${graceful})`);
    this.ws.emit('close', { code: graceful ? GRACEFUL_DISCONNECT_CODE : 1001 });
  }

  public async sendRequest(task: Pick<RequestPromise, 'description' | 'payload' | 'callback'>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isDisposed) {
        reject(new Error('WebSocket: Cannot queue request, client is disposed'));
        return;
      }

      this.requestQueue.push({ ...task, resolve, reject, attempts: 0 });
      this.startQueueSystem();
    });
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.options.logger('WebSocket: Disposing client');
    this.isDisposed = true;
    this.disconnect(true);
  }

  private handleOpen(): void {
    if (this.state !== WebSocketState.CONNECTING) {
      return;
    }

    this.state = WebSocketState.OPEN;
    this.reconnectAttempts = 0;
    this.stopReconnectSystem();
    this.options.logger('WebSocket: Connection established');

    Promise.resolve(this.onOpen())
      .then(() => {
        if (this.state !== WebSocketState.OPEN) {
          this.options.logger('WebSocket: State changed during onOpen handler execution or client disposed');
          this.disconnect(false);
          return;
        }

        this.startPingSystem();
        this.startQueueSystem();
      })
      .catch((error: unknown) => {
        this.options.logger(error, 'WebSocket: Error during onOpen handler');
        this.disconnect(false);
      });
  }

  private handleClose(event: CloseEvent): void {
    if (!this.ws || this.state === WebSocketState.CLOSED) {
      return;
    }

    this.state = WebSocketState.CLOSED;
    const oldWs = this.ws;
    this.ws = undefined;

    this.options.logger('WebSocket: Terminating existing connection');
    oldWs.removeAllListeners();
    oldWs.once('error', Boolean);
    oldWs.terminate();

    this.stopPingSystem();
    this.stopReconnectSystem();

    const eventError = new Error('WebSocket: Connection closed');
    Object.assign(eventError, { event });
    this.rejectAllQueued(eventError);

    Promise.resolve(this.onClose(eventError))
      .catch((error: unknown) => {
        this.options.logger(error, 'WebSocket: Error during onClose handler');
      })
      .finally(() => {
        if (this.isDisposed) {
          this.options.logger('WebSocket: Connection closed post-disposal');
        } else if (event.code === GRACEFUL_DISCONNECT_CODE || this.options.reconnectMaxAttempts === 0) {
          return;
        } else {
          this.startReconnectSystem();
        }
      });
  }

  private handleError(event: ErrorEvent): void {
    const eventError = new Error('WebSocket: Error event received');
    Object.assign(eventError, { event });
    Promise.resolve(this.onError(eventError)).catch((error: unknown) => {
      this.options.logger(error, 'WebSocket: Error during onError handler');
    });
  }

  private handleMessage(data: unknown): void {
    if (this.state !== WebSocketState.OPEN) {
      return;
    }

    Promise.resolve(this.onMessage(data)).catch((error: unknown) => {
      this.options.logger(error, 'WebSocket: Error during onMessage handler');
    });
  }

  private startQueueSystem(): void {
    queueMicrotask(() => {
      if (this.state !== WebSocketState.OPEN || this.isRequestActive || this.requestQueue.length === 0) {
        return;
      } else if (!this.ws || this.ws.readyState !== ws.OPEN) {
        this.options.logger('WebSocket: Socket not open despite Open state, forcing reconnect');
        this.disconnect(false);
        return;
      }

      const currentRequest = this.requestQueue[0]!;
      if (this.ws.bufferedAmount > this.options.bufferedThresholdAmount) {
        this.options.logger(
          `WebSocket: Request '${currentRequest.description}' paused due to high bufferedAmount: ${this.ws.bufferedAmount}, retrying`,
        );
        setTimeout(() => this.startQueueSystem(), 100);
        return;
      }

      this.isRequestActive = true;
      currentRequest.attempts += 1;

      const sendPromise = new Promise<void>((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== ws.OPEN) {
          reject(new Error('WebSocket: Connection closed before send'));
          return;
        }

        currentRequest.timeoutId = setTimeout(() => {
          currentRequest.timeoutId = undefined;
          reject(new Error(`WebSocket: Request '${currentRequest.description}' timed out after ${this.options.requestTimeoutMs}ms`));
        }, this.options.requestTimeoutMs);

        this.ws.send(currentRequest.payload as Buffer, (error: unknown) => {
          clearTimeout(currentRequest.timeoutId);
          currentRequest.timeoutId = undefined;

          if (currentRequest.callback?.(error) ?? error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      sendPromise
        .then(() => {
          currentRequest.resolve();
          this.requestQueue.shift();
          this.isRequestActive = false;
          this.startQueueSystem();
        })
        .catch((error) => {
          if (currentRequest.attempts >= this.options.requestMaxAttempts) {
            currentRequest.reject(error);
            this.requestQueue.shift();
            this.isRequestActive = false;
            this.startQueueSystem();
          } else {
            this.isRequestActive = false;
            currentRequest.timeoutId = setTimeout(() => {
              currentRequest.timeoutId = undefined;
              this.startQueueSystem();
            }, this.options.requestRetryMs);
          }
        });
    });
  }

  private rejectAllQueued(reason: Error): void {
    if (this.requestQueue.length === 0) {
      return;
    }

    while (this.requestQueue.length > 0) {
      const req = this.requestQueue.shift()!;
      if (req.timeoutId) {
        clearTimeout(req.timeoutId);
        req.timeoutId = undefined;
      }
      req.reject(reason);
    }
    this.isRequestActive = false;
  }

  private startPingSystem(): void {
    this.stopPingSystem();
    if (this.state !== WebSocketState.OPEN) {
      return;
    }

    Promise.resolve(this.onPing())
      .catch((error: unknown) => {
        this.options.logger(error, 'WebSocket: Error during onPing handler');
      })
      .finally(() => {
        if (this.state === WebSocketState.OPEN) {
          this.pingTimeoutId = setTimeout(() => {
            this.pingTimeoutId = undefined;
            this.startPingSystem();
          }, this.options.pingIntervalMs);
        }
      });
  }

  private stopPingSystem(): void {
    if (this.pingTimeoutId) {
      clearTimeout(this.pingTimeoutId);
      this.pingTimeoutId = undefined;
    }
  }

  private startReconnectSystem(): void {
    this.stopReconnectSystem();
    if (this.isDisposed || this.state === WebSocketState.CONNECTING || this.state === WebSocketState.OPEN) {
      return;
    } else if (this.reconnectAttempts >= this.options.reconnectMaxAttempts) {
      Promise.resolve(this.onMaxReconnects()).catch((error: unknown) => {
        this.options.logger(error, 'WebSocket: Error during onMaxReconnect handler');
      });
      return;
    }

    this.state = WebSocketState.RECONNECTING;
    this.reconnectAttempts += 1;

    const baseDelay = this.options.reconnectBaseMs * 1.5 ** (this.reconnectAttempts - 1);
    const jitter = baseDelay * 0.4 * (Math.random() - 0.5);
    const delay = Math.min(this.options.reconnectMaxMs, Math.floor(baseDelay + jitter));

    const maxAttempts = this.options.reconnectMaxAttempts === Infinity ? '∞' : this.options.reconnectMaxAttempts;
    this.options.logger(`WebSocket: Reconnect attempt ${this.reconnectAttempts}/${maxAttempts} in ${delay}ms`);

    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = undefined;
      if (this.state === WebSocketState.RECONNECTING) {
        this.connect();
      } else {
        this.options.logger('WebSocket: Reconnect aborted due to disposal or state change from reconnecting');
      }
    }, delay);
  }

  private stopReconnectSystem(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = undefined;
    }
  }
}
