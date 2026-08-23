import mqtt, { type MqttClient } from 'mqtt';

import { md5hex, randomAlphanumeric } from './crypto.js';
import type { RRiot } from './types.js';
import { decodeFrames, parseDpsPush, PROTOCOL_DPS_PUSH } from './v1-protocol.js';

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

export class RoborockMqtt {
  private client?: MqttClient;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly connectionListeners: ((connected: boolean) => void)[] = [];
  private lastConnected = false;

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

  // The Roborock broker can silently drop a long-lived subscription while the connection still looks healthy.
  // Re-issuing SUBSCRIBE is idempotent and cheap; a refused suback means the session is broken, so start over.
  resubscribe(): void {
    const client = this.client;
    if (!client?.connected) {
      return;
    }
    for (const duid of this.subscriptions.keys()) {
      client.subscribe(this.topicFor(duid), { qos: 0 }, (error) => {
        if (error && this.client === client) {
          this.log.warn(`Roborock MQTT re-subscribe failed (${error.message}); reconnecting.`);
          this.restart();
        }
      });
    }
  }

  // Tear the connection down and build a fresh one; late events from the replaced client are ignored.
  restart(): void {
    const old = this.client;
    this.client = undefined;
    old?.end(true);
    this.start();
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener);
  }

  private topicFor(duid: string): string {
    return `rr/m/o/${this.rriot.u}/${mqttCredentials(this.rriot).username}/${duid}`;
  }

  private subscribeTopic(duid: string): void {
    this.client?.subscribe(this.topicFor(duid), { qos: 0 }, (error) => {
      if (error) {
        this.log.warn(`Roborock MQTT subscribe failed for ${duid}: ${error.message}`);
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
