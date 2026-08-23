import { hawkAuthorization, headerClientId, randomAlphanumeric } from './crypto.js';
import { HOME_DATA_LIMITS, LOGIN_LIMITS, RateLimiter } from './rate-limiter.js';
import { type HomeData, type RegionInfo, RoborockApiError, type UserData } from './types.js';

export const BASE_URLS = [
  'https://usiot.roborock.com',
  'https://euiot.roborock.com',
  'https://cniot.roborock.com',
  'https://ruiot.roborock.com',
];

// Mirrors the Roborock app. Roborock periodically starts rejecting older values (code 1002 / 3009) — bump here.
export const APP_HEADERS = {
  header_appversion: '4.54.02',
  header_phonesystem: 'iOS',
  header_phonemodel: 'iPhone16,1',
  header_clientlang: 'en',
};
export const AGREEMENT_VERSION = { majorVersion: '14', minorVersion: '0' };

const KNOWN_ERRORS: Record<number, string> = {
  1002: 'Roborock rejected the request parameters (code 1002); the app headers in this plugin may need updating.',
  2003: 'Email address is not valid.',
  2008: 'No Roborock account exists for this email.',
  2010: 'Roborock session is no longer valid. Sign in again.',
  2018: 'Invalid or expired verification code.',
  2031: 'This account requires two-step verification; use the email code sign-in.',
  3006: 'Accept the updated user agreement in the Roborock app, then try again.',
  3009: 'Accept the user agreement in the Roborock app, then try again.',
  3030: 'Account belongs to a different Roborock region.',
  3039: 'No account found in this Roborock region.',
  9002: 'Too many verification codes requested. Wait a few minutes and try again.',
};

const CLOCK_SKEW_LIMIT_SECONDS = 60;

interface Envelope {
  code?: number;
  msg?: string;
  data?: unknown;
  success?: boolean;
  result?: unknown;
}

async function parseEnvelope(response: Response): Promise<Envelope> {
  try {
    return await response.json() as Envelope;
  } catch {
    throw new RoborockApiError(`Roborock returned a non-JSON response (HTTP ${response.status}).`);
  }
}

function errorForCode(envelope: Envelope, fallback?: string): RoborockApiError {
  const known = envelope.code === undefined ? undefined : KNOWN_ERRORS[envelope.code];
  return new RoborockApiError(known ?? fallback ?? `Roborock error ${envelope.code ?? '?'}: ${envelope.msg ?? 'unknown error'}`, envelope.code);
}

function ensureOk(envelope: Envelope): void {
  if (envelope.code !== 200) {
    throw errorForCode(envelope);
  }
}

export interface RoborockWebApiOptions {
  email: string;
  clientId: string;
  region?: RegionInfo;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class RoborockWebApi {
  region?: RegionInfo;

  private readonly email: string;
  private readonly clientId: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly loginLimiter: RateLimiter;
  private readonly homeDataLimiter: RateLimiter;
  private candidates = [...BASE_URLS];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RoborockWebApiOptions) {
    this.email = options.email;
    this.clientId = options.clientId;
    this.region = options.region;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.loginLimiter = new RateLimiter(LOGIN_LIMITS, this.now);
    this.homeDataLimiter = new RateLimiter(HOME_DATA_LIMITS, this.now);
  }

  // All cloud calls go through one lane: Roborock tolerates little concurrency and we share the account with the app.
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private acquire(limiter: RateLimiter, what: string): void {
    if (!limiter.tryAcquire()) {
      throw new RoborockApiError(`Roborock ${what} rate limit reached; try again later.`, 429);
    }
  }

  // Asks each regional host whether it knows the account; the answer also carries the country values the login needs.
  async resolveRegion(): Promise<RegionInfo> {
    let unreachable = 0;
    for (const baseUrl of this.candidates) {
      const url = new URL('/api/v1/getUrlByEmail', baseUrl);
      url.searchParams.set('email', this.email);
      url.searchParams.set('needtwostepauth', 'false');
      let envelope: Envelope;
      try {
        envelope = await this.call(url, { method: 'POST', headers: this.loginHeaders() });
      } catch {
        unreachable++;
        continue;
      }
      if (envelope.code === 2003 || envelope.code === 1001) {
        throw errorForCode(envelope);
      }
      const data = envelope.data as { url?: string; country?: string; countrycode?: string } | undefined;
      if (envelope.code === 200 && data?.url) {
        this.region = { baseUrl: data.url, country: data.country ?? '', countryCode: String(data.countrycode ?? '') };
        return this.region;
      }
    }
    if (unreachable === this.candidates.length) {
      throw new RoborockApiError('Could not reach the Roborock servers (network or DNS). Check connectivity and try again.');
    }
    throw new RoborockApiError('Could not find a Roborock region for this account. Check the email address.');
  }

  requestEmailCode(): Promise<RegionInfo> {
    return this.serialize(() => {
      this.acquire(this.loginLimiter, 'login');
      return this.requestEmailCodeNow();
    });
  }

  // Region fallback (3030) retries internally; the limiter is charged once per user action, in requestEmailCode().
  private async requestEmailCodeNow(): Promise<RegionInfo> {
    const region = this.region ?? await this.resolveRegion();
    const envelope = await this.postForm(
      new URL('/api/v4/email/code/send', region.baseUrl),
      { email: this.email, type: 'login', platform: '' },
      this.loginHeaders(),
    );
    if (envelope.code === 3030 && this.candidates.length > 1) {
      this.candidates = this.candidates.filter((base) => base !== region.baseUrl);
      this.region = undefined;
      return this.requestEmailCodeNow();
    }
    ensureOk(envelope);
    return region;
  }

  loginWithCode(code: string): Promise<UserData> {
    return this.serialize(() => {
      this.acquire(this.loginLimiter, 'login');
      return this.loginWithCodeNow(code);
    });
  }

  private async loginWithCodeNow(code: string): Promise<UserData> {
    const region = this.region ?? await this.resolveRegion();
    const s = randomAlphanumeric(16);
    const signUrl = new URL('/api/v3/key/sign', region.baseUrl);
    signUrl.searchParams.set('s', s);
    const signed = await this.call(signUrl, { method: 'POST', headers: this.loginHeaders() });
    const k = (signed.data as { k?: string } | undefined)?.k;
    if (!k) {
      throw new RoborockApiError('Roborock did not return a signing key.', signed.code);
    }

    const envelope = await this.postForm(
      new URL('/api/v4/auth/email/login/code', region.baseUrl),
      { country: region.country, countryCode: region.countryCode, email: this.email, code, ...AGREEMENT_VERSION },
      { ...this.loginHeaders(), 'x-mercy-ks': s, 'x-mercy-k': k },
    );
    ensureOk(envelope);
    const userData = envelope.data as UserData | undefined;
    if (!userData?.token || !userData.rriot) {
      throw new RoborockApiError('Roborock login response is missing token or rriot data.');
    }
    return userData;
  }

  getHomeId(userData: UserData): Promise<number> {
    return this.serialize(() => this.getHomeIdNow(userData));
  }

  private async getHomeIdNow(userData: UserData): Promise<number> {
    const region = this.region ?? await this.resolveRegion();
    const envelope = await this.call(new URL('/api/v1/getHomeDetail', region.baseUrl), {
      headers: { ...this.loginHeaders(), Authorization: userData.token },
    });
    ensureOk(envelope);
    const homeId = (envelope.data as { rrHomeId?: number } | undefined)?.rrHomeId;
    if (homeId === undefined) {
      throw new RoborockApiError('Roborock did not return a home id.');
    }
    return homeId;
  }

  getHomeData(userData: UserData, homeId: number): Promise<HomeData> {
    return this.serialize(() => this.getHomeDataNow(userData, homeId));
  }

  private async getHomeDataNow(userData: UserData, homeId: number): Promise<HomeData> {
    this.acquire(this.homeDataLimiter, 'home-data');
    const host = userData.rriot.r.a;
    if (!host) {
      throw new RoborockApiError('Session is missing the Roborock API host (rriot.r.a).');
    }
    const path = `/v3/user/homes/${homeId}`;
    const response = await this.send(new URL(path, host), {
      headers: { Authorization: hawkAuthorization(userData.rriot, path, { timestamp: Math.floor(this.now() / 1000) }) },
    });
    if (response.status === 401) {
      throw this.signedRequestRejected(response);
    }
    const envelope = await parseEnvelope(response);
    if (!envelope.success) {
      throw errorForCode(envelope, `Roborock home data request failed: ${envelope.msg ?? 'unknown error'}`);
    }
    return envelope.result as HomeData;
  }

  private loginHeaders(): Record<string, string> {
    return { header_clientid: headerClientId(this.email, this.clientId), ...APP_HEADERS };
  }

  private postForm(url: URL, form: Record<string, string>, headers: Record<string, string>): Promise<Envelope> {
    return this.call(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async call(url: URL, init: RequestInit): Promise<Envelope> {
    return parseEnvelope(await this.send(url, init));
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new RoborockApiError(`Could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok && response.status !== 401) {
      throw new RoborockApiError(`Roborock returned HTTP ${response.status} for ${url.pathname}`);
    }
    return response;
  }

  private signedRequestRejected(response: Response): RoborockApiError {
    const serverTime = Date.parse(response.headers.get('date') ?? '');
    const skewSeconds = Number.isNaN(serverTime) ? 0 : Math.round((serverTime - this.now()) / 1000);
    if (Math.abs(skewSeconds) > CLOCK_SKEW_LIMIT_SECONDS) {
      const direction = skewSeconds > 0 ? 'behind' : 'ahead of';
      return new RoborockApiError(
        `Roborock rejected the signed request and this host's clock is ${Math.abs(skewSeconds)}s ${direction} the server. Fix time sync (NTP) and restart.`,
        401,
      );
    }
    return new RoborockApiError('Roborock rejected the signed request (401). Sign in again.', 401);
  }
}
