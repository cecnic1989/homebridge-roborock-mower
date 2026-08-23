import { createHash, createHmac, randomInt } from 'node:crypto';

import type { RRiot } from './types.js';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function md5hex(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

// Used for the key/sign nonce (`s`) and the Hawk nonce.
export function randomAlphanumeric(length: number): string {
  return Array.from({ length }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join('');
}

// Roborock expects base64 of the raw digest, not of the hex string.
export function headerClientId(email: string, clientId: string): string {
  return createHash('md5').update(email).update(clientId).digest('base64');
}

export interface HawkOptions {
  params?: Record<string, string>;
  body?: unknown;
  nonce?: string;
  timestamp?: number;
}

function sortedFormMd5(values?: Record<string, string>): string {
  if (!values) {
    return '';
  }
  const query = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('&');
  return md5hex(query);
}

export function hawkAuthorization(rriot: Pick<RRiot, 'u' | 's' | 'h'>, path: string, options: HawkOptions = {}): string {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? randomAlphanumeric(6);
  const payloadMd5 = options.body === undefined ? '' : md5hex(JSON.stringify(options.body));
  const prestr = [rriot.u, rriot.s, nonce, String(timestamp), md5hex(path), sortedFormMd5(options.params), payloadMd5].join(':');
  const mac = createHmac('sha256', rriot.h).update(prestr).digest('base64');
  return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${timestamp}",nonce="${nonce}",mac="${mac}"`;
}
