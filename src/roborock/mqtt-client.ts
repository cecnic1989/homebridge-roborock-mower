import mqtt, { type MqttClient } from 'mqtt';

import { md5hex, randomAlphanumeric } from './crypto.js';
import type { RRiot } from './types.js';
import { decodeFrames, encodeV1Frame, parseDpsPush, parseRpcResponse, PROTOCOL_DPS_PUSH, PROTOCOL_RPC_REQUEST, type RpcResponse } from './v1-protocol.js';

export interface MqttCredentials {
  url: string;
  username: string;
  password: string;
}

export interface MqttLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export type DpsListener = (dps: Record<number, unknown>) => void;

// Same derivation as the Roborock app (and python-roborock / ioBroker).
export function mqttCredentials(rriot: Pick<RRiot, 'u' | 's' | 'k'> & { r: Pick<RRiot['r'], 'm'> }): MqttCredentials {
  if (!rriot.r.m) {
    throw new Error('Session is missing the Roborock MQTT broker (rriot.r.m).');
  }
  return {
    url: rriot.r.m,
    username: md5hex(`${rriot.u}:${rriot.k}`).slice(2, 10),
    password: md5hex(`${rriot.s}:${rriot.k}`).slice(16),
  };
}

interface Subscription {
  localKey: string;
  onDps: DpsListener;
}

const RESUBSCRIBE_INTERVAL_MS = 15 * 60_000; // the broker can silently drop a subscription; SUBSCRIBE is idempotent
const REFUSAL_RESTART_COOLDOWN_MS = 60_000; // a broker that keeps refusing must not spin us into a restart loop
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RoborockMqtt {
  private client?: MqttClient;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly connectionListeners: ((connected: boolean) => void)[] = [];
  private lastConnected = false;
  private resubscribeTimer?: NodeJS.Timeout;
  private lastRefusalRestart = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly requestQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly rriot: RRiot,
    private readonly log: MqttLogger,
    private readonly connect: typeof mqtt.connect = mqtt.connect,
  ) {}

  start(): void {
    const creds = mqttCredentials(this.rriot);
    // A per-process suffix keeps two instances on one account (e.g. dev + production) from evicting each other;
    // the broker accepts any clientId as long as username/password match.
    const client = this.connect(creds.url, {
      clientId: `${creds.username}-${randomAlphanumeric(6)}`,
      username: creds.username,
      password: creds.password,
      keepalive: 30,
      clean: true,
      reconnectPeriod: 15_000,
    });
    this.client = client;
    client.on('connect', () => {
      if (this.client !== client) {
        return; // a connect that raced stop()
      }
      this.log.info('Roborock MQTT connected');
      for (const duid of this.subscriptions.keys()) {
        this.subscribeTopic(duid);
      }
      this.emitConnection(true);
    });
    client.on('close', () => {
      if (this.client === client) {
        this.emitConnection(false);
      }
    });
    client.on('offline', () => {
      if (this.client === client) {
        this.emitConnection(false);
      }
    });
    client.on('reconnect', () => this.log.debug('Roborock MQTT reconnecting'));
    client.on('error', (error) => this.log.warn(`Roborock MQTT error: ${error.message}`));
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    this.resubscribeTimer = setInterval(() => this.resubscribe(), RESUBSCRIBE_INTERVAL_MS);
    this.resubscribeTimer.unref?.();
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  // Listeners stay attached: mqtt.js clears its connack timer from its own 'close' handler, and our 'error'
  // handler must outlive end() so a late error cannot become an uncaught exception. lastConnected=false
  // keeps the shutdown 'close' from being reported as an outage.
  stop(): void {
    const client = this.client;
    this.client = undefined;
    this.lastConnected = false;
    clearInterval(this.resubscribeTimer);
    this.rejectPending('Roborock MQTT connection closed.');
    client?.end(true);
  }

  subscribe(duid: string, localKey: string, onDps: DpsListener): void {
    this.subscriptions.set(duid, { localKey, onDps });
    if (this.client?.connected) {
      this.subscribeTopic(duid);
    }
  }

  unsubscribe(duid: string): void {
    if (this.subscriptions.delete(duid)) {
      this.client?.unsubscribe(this.topicFor(duid));
    }
  }

  // Re-issue every SUBSCRIBE — idempotent, cheap, and heals a subscription the broker silently dropped.
  resubscribe(): void {
    if (!this.client?.connected) {
      return;
    }
    for (const duid of this.subscriptions.keys()) {
      this.subscribeTopic(duid);
    }
  }

  // Tear the connection down and build a fresh one. Listeners hear the drop immediately — the old sensors must
  // not look live while the replacement is still connecting; late events from the replaced client are ignored.
  restart(): void {
    const old = this.client;
    this.client = undefined;
    clearInterval(this.resubscribeTimer);
    this.rejectPending('Roborock MQTT connection closed.');
    old?.end(true);
    this.emitConnection(false);
    this.start();
  }

  // One command at a time per mower — the broker and firmware tolerate little concurrency, and racing a dock
  // against a mow from two automations must resolve in a defined order.
  request(duid: string, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const queue = this.requestQueues.get(duid) ?? Promise.resolve();
    const run = () => this.requestNow(duid, method, params, timeoutMs);
    const result = queue.then(run, run);
    this.requestQueues.set(duid, result.catch(() => undefined));
    return result;
  }

  private requestNow(duid: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const client = this.client;
    const subscription = this.subscriptions.get(duid);
    if (!client?.connected) {
      return Promise.reject(new Error('Roborock MQTT is not connected.'));
    }
    if (!subscription) {
      return Promise.reject(new Error(`No MQTT subscription for ${duid}.`));
    }
    const id = 10_000 + Math.floor(Math.random() * 22_767);
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ dps: { '101': JSON.stringify({ id, method, params }) }, t: timestamp });
    const frame = encodeV1Frame(
      PROTOCOL_RPC_REQUEST, timestamp, payload, subscription.localKey,
      Math.floor(Math.random() * 0x7fffffff), Math.floor(Math.random() * 0x7fffffff),
    );
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Roborock ${method} timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer });
      client.publish(this.inTopicFor(duid), frame, { qos: 0 }, (error) => {
        if (error && this.pendingRequests.delete(id)) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private settleRequest(reply: RpcResponse): void {
    const pending = this.pendingRequests.get(reply.id);
    if (!pending) {
      return; // another client's request on the shared topic
    }
    this.pendingRequests.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error !== undefined) {
      pending.reject(new Error(`Roborock rejected the command: ${JSON.stringify(reply.error)}`));
    } else {
      pending.resolve(reply.result);
    }
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener);
  }

  private topicFor(duid: string): string {
    return `rr/m/o/${this.rriot.u}/${mqttCredentials(this.rriot).username}/${duid}`;
  }

  private inTopicFor(duid: string): string {
    return `rr/m/i/${this.rriot.u}/${mqttCredentials(this.rriot).username}/${duid}`;
  }

  // A refused suback means the session is broken (the broker acknowledged the request and said no), so a fresh
  // connection is the only repair — but never more than once a minute, in case the refusal is persistent.
  private subscribeTopic(duid: string): void {
    const client = this.client;
    client?.subscribe(this.topicFor(duid), { qos: 0 }, (error) => {
      if (!error || this.client !== client) {
        return;
      }
      this.log.warn(`Roborock MQTT subscribe failed for ${duid}: ${error.message}`);
      if (Date.now() - this.lastRefusalRestart >= REFUSAL_RESTART_COOLDOWN_MS) {
        this.lastRefusalRestart = Date.now();
        this.restart();
      }
    });
  }

  private onMessage(topic: string, payload: Buffer): void {
    const duid = topic.slice(topic.lastIndexOf('/') + 1);
    const subscription = this.subscriptions.get(duid);
    if (!subscription) {
      return;
    }
    for (const frame of decodeFrames(payload, subscription.localKey)) {
      if (frame.protocol !== PROTOCOL_DPS_PUSH) {
        this.log.debug(`MQTT ${duid}: protocol ${frame.protocol}, ${frame.payload.length} bytes`);
        continue;
      }
      const reply = parseRpcResponse(frame.payload);
      if (reply) {
        this.settleRequest(reply);
        continue;
      }
      const dps = parseDpsPush(frame.payload);
      if (dps && Object.keys(dps).length > 0) {
        subscription.onDps(dps);
      }
    }
  }

  // mqtt.js emits close after every failed reconnect attempt; listeners only want the transitions.
  private emitConnection(connected: boolean): void {
    if (connected === this.lastConnected) {
      return;
    }
    this.lastConnected = connected;
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }
}
