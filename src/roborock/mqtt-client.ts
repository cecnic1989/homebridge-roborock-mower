import mqtt, { type MqttClient } from 'mqtt';

import { md5hex, randomAlphanumeric } from './crypto.js';
import type { RRiot } from './types.js';
import { decodeFrames, encodeV1Frame, parseV1Payload, PROTOCOL_DPS_PUSH, PROTOCOL_RPC_REQUEST, type RpcResponse } from './v1-protocol.js';

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

// The mower answered, but with an error body. For a liveness probe this still proves the subscription:
// the frame travelled the same broker path as state pushes.
class RpcErrorReply extends Error {}

// The request was torn down by our own stop/restart/unsubscribe — says nothing about the subscription.
class RequestAborted extends Error {}

// The request went out and nothing came back — the only failure that actually indicts the subscription.
export class RequestTimeout extends Error {}

export type ProbeOutcome = 'alive' | 'skipped' | 'dead';

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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

interface QueuedCommand {
  start: () => void;
  cancel: (reason: string) => void;
}

interface CommandQueue {
  running: boolean;
  queued?: QueuedCommand;
}

export class RoborockMqtt {
  private client?: MqttClient;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly connectionListeners: ((connected: boolean) => void)[] = [];
  private readonly frameListeners: ((duid: string) => void)[] = [];
  private lastConnected = false;
  private resubscribeTimer?: NodeJS.Timeout;
  private lastRefusalRestart = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly commandQueues = new Map<string, CommandQueue>();

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
      this.rejectPending('Mower unsubscribed.', duid);
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

  // One command at a time per mower, latest wins: while one is on the wire at most one more waits, and a newer
  // command replaces the waiting one — stale intents must never replay against the physical mower minutes later.
  request(duid: string, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const queue = this.commandQueues.get(duid) ?? { running: false };
      this.commandQueues.set(duid, queue);
      const job: QueuedCommand = {
        // Queue bookkeeping settles BEFORE the caller is notified, so busy() answers correctly from a
        // caller's catch block: an empty queue is already gone, a queued successor is already running.
        start: () => this.requestNow(duid, method, params, timeoutMs)
          .finally(() => this.onCommandSettled(duid, queue))
          .then(resolve, reject),
        cancel: (reason) => reject(new Error(reason)),
      };
      if (queue.running) {
        queue.queued?.cancel('Superseded by a newer command.');
        queue.queued = job;
      } else {
        queue.running = true;
        job.start();
      }
    });
  }

  // End-to-end subscription check. Never rejects, never enters the command queue: a queued probe could
  // evict a waiting user command through the one-slot "superseded" path, and a busy queue means a command
  // reply is about to prove liveness anyway.
  async probe(duid: string, method: string, params: unknown): Promise<ProbeOutcome> {
    if (!this.client?.connected || !this.subscriptions.has(duid) || this.commandQueues.has(duid)) {
      return 'skipped';
    }
    try {
      await this.requestNow(duid, method, params, REQUEST_TIMEOUT_MS);
      return 'alive';
    } catch (error) {
      if (error instanceof RpcErrorReply) {
        return 'alive';
      }
      // Only a timeout indicts the subscription; a local publish error or our own teardown never tested it.
      return error instanceof RequestTimeout ? 'dead' : 'skipped';
    }
  }

  // Whether a user command is in flight or queued for any mower. A restart rejects every pending command
  // account-wide, so restart decisions must consider them all, not just the mower being checked.
  busy(): boolean {
    return this.commandQueues.size > 0;
  }

  // Runs from a .finally() ahead of the caller's settlement, so it must never throw: a synchronous failure
  // starting the successor would otherwise replace the predecessor's result and leave the successor hanging.
  private onCommandSettled(duid: string, queue: CommandQueue): void {
    if (this.commandQueues.get(duid) !== queue) {
      return; // the queue was torn down (stop/restart/unsubscribe) while this command was settling
    }
    const next = queue.queued;
    queue.queued = undefined;
    if (!next) {
      this.commandQueues.delete(duid);
      return;
    }
    try {
      next.start();
    } catch (error) {
      this.commandQueues.delete(duid);
      next.cancel(message(error));
    }
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
    // A probe can be pending alongside a user command (it bypasses the queue), so re-roll a colliding id:
    // a shared id would let one reply settle the other's request.
    let id = 10_000 + Math.floor(Math.random() * 22_767);
    while (this.pendingRequests.has(`${duid}:${id}`)) {
      id = 10_000 + ((id - 10_000 + 1) % 22_767);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const resolvedParams = typeof params === 'function' ? (params as () => unknown)() : params;
    const payload = JSON.stringify({ dps: { '101': JSON.stringify({ id, method, params: resolvedParams }) }, t: timestamp });
    const frame = encodeV1Frame(
      PROTOCOL_RPC_REQUEST, timestamp, payload, subscription.localKey,
      Math.floor(Math.random() * 0x7fffffff), Math.floor(Math.random() * 0x7fffffff),
    );
    return new Promise<unknown>((resolve, reject) => {
      const key = `${duid}:${id}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new RequestTimeout(`Roborock ${method} timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(key, { resolve, reject, timer });
      client.publish(this.inTopicFor(duid), frame, { qos: 0 }, (error) => {
        if (error && this.pendingRequests.delete(key)) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  // Ids are only unique per mower; the account topic also carries other clients' replies.
  private settleRequest(duid: string, reply: RpcResponse): void {
    const key = `${duid}:${reply.id}`;
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      return; // another client's request on the shared topic
    }
    this.pendingRequests.delete(key);
    clearTimeout(pending.timer);
    if (reply.error !== undefined) {
      pending.reject(new RpcErrorReply(`Roborock rejected the command: ${JSON.stringify(reply.error)}`));
    } else {
      pending.resolve(reply.result);
    }
  }

  private rejectPending(reason: string, duid?: string): void {
    for (const [key, pending] of this.pendingRequests) {
      if (duid !== undefined && !key.startsWith(`${duid}:`)) {
        continue;
      }
      this.pendingRequests.delete(key);
      clearTimeout(pending.timer);
      pending.reject(new RequestAborted(reason));
    }
    for (const [queueDuid, queue] of this.commandQueues) {
      if (duid !== undefined && queueDuid !== duid) {
        continue;
      }
      queue.queued?.cancel(reason);
      this.commandQueues.delete(queueDuid);
    }
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener);
  }

  // Fires once per message that carried at least one decodable frame for a subscribed mower — pushes, our
  // replies, and other clients' replies all count as proof the subscription delivers.
  onFrame(listener: (duid: string) => void): void {
    this.frameListeners.push(listener);
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
    const frames = decodeFrames(payload, subscription.localKey);
    if (frames.length > 0) {
      for (const listener of this.frameListeners) {
        listener(duid);
      }
    }
    for (const frame of frames) {
      if (frame.protocol !== PROTOCOL_DPS_PUSH) {
        this.log.debug(`MQTT ${duid}: protocol ${frame.protocol}, ${frame.payload.length} bytes`);
        continue;
      }
      const parsed = parseV1Payload(frame.payload);
      if (parsed?.rpc) {
        this.settleRequest(duid, parsed.rpc);
      }
      if (parsed?.dps) {
        subscription.onDps(parsed.dps);
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
