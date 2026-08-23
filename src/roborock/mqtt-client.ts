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

  constructor(
    private readonly rriot: RRiot,
    private readonly log: MqttLogger,
    private readonly connect: typeof mqtt.connect = mqtt.connect,
  ) {}

  start(): void {
    const creds = mqttCredentials(this.rriot);
    // A per-process suffix keeps two instances on one account (e.g. dev + production) from evicting each other;
    // the broker accepts any clientId as long as username/password match.
    this.client = this.connect(creds.url, {
      clientId: `${creds.username}-${randomAlphanumeric(6)}`,
      username: creds.username,
      password: creds.password,
      keepalive: 30,
      clean: true,
      reconnectPeriod: 15_000,
    });
    this.client.on('connect', () => {
      this.log.info('Roborock MQTT connected');
      for (const duid of this.subscriptions.keys()) {
        this.subscribeTopic(duid);
      }
      this.emitConnection(true);
    });
    this.client.on('close', () => this.emitConnection(false));
    this.client.on('reconnect', () => this.log.debug('Roborock MQTT reconnecting'));
    this.client.on('error', (error) => this.log.warn(`Roborock MQTT error: ${error.message}`));
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  stop(): void {
    const client = this.client;
    this.client = undefined;
    client?.removeAllListeners();
    client?.end(true);
  }

  subscribe(duid: string, localKey: string, onDps: DpsListener): void {
    this.subscriptions.set(duid, { localKey, onDps });
    if (this.client?.connected) {
      this.subscribeTopic(duid);
    }
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

  private emitConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }
}
