import { randomUUID } from 'node:crypto';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { describeMowState, deriveMowerState } from '../mower/state.js';
import { findMowers } from '../roborock/mower.js';
import { clearSession, type PlatformStatus, readSession, readStatus, type StatusDevice, writeSession, writeStatus } from '../roborock/session-store.js';
import type { RegionInfo, StoredSession } from '../roborock/types.js';
import { RoborockWebApi } from '../roborock/web-api.js';

interface SendCodePayload {
  email: string;
}

interface VerifyCodePayload extends SendCodePayload {
  clientId: string;
  region: RegionInfo;
  code: string;
}

interface DevicesResponse extends PlatformStatus {
  stale: boolean;
}

const STALE_AFTER_MS = 2 * 60 * 60_000;

class RoborockMowerUiServer extends HomebridgePluginUiServer {
  // One cloud client per account for the life of this UI process, so the send/verify pair shares its rate limiter.
  private current?: { email: string; clientId: string; api: RoborockWebApi };

  constructor() {
    super();
    this.onRequest('/session', () => this.guard(() => this.session()));
    this.onRequest('/auth/send-code', (payload: SendCodePayload) => this.guard(() => this.sendCode(payload)));
    this.onRequest('/auth/verify-code', (payload: VerifyCodePayload) => this.guard(() => this.verifyCode(payload)));
    this.onRequest('/auth/sign-out', () => this.guard(() => this.signOut()));
    this.onRequest('/devices', () => this.guard(() => this.devices()));
    this.ready();
  }

  private get storagePath(): string {
    if (!this.homebridgeStoragePath) {
      throw new Error('Homebridge storage path is not available to the plugin UI.');
    }
    return this.homebridgeStoragePath;
  }

  private apiFor(email: string, clientId: string, region?: RegionInfo): RoborockWebApi {
    if (this.current?.email !== email || this.current.clientId !== clientId) {
      this.current = { email, clientId, api: new RoborockWebApi({ email, clientId, region }) };
    }
    return this.current.api;
  }

  private async session(): Promise<{ email: string | null; lastError?: string }> {
    const session = await readSession(this.storagePath);
    const status = await readStatus(this.storagePath);
    return { email: session?.email ?? null, lastError: status?.lastError };
  }

  private async sendCode({ email }: SendCodePayload) {
    const clientId = randomUUID();
    const region = await this.apiFor(email, clientId).requestEmailCode();
    return { clientId, region };
  }

  private async verifyCode({ email, clientId, region, code }: VerifyCodePayload): Promise<{ email: string }> {
    const userData = await this.apiFor(email, clientId, region).loginWithCode(code.trim());
    await writeSession(this.storagePath, { email, clientId, region, userData });
    await writeStatus(this.storagePath, { updatedAt: 0, devices: [] }); // clears any session-expired flag
    return { email };
  }

  private async signOut(): Promise<void> {
    await clearSession(this.storagePath);
  }

  // Serves the platform's status file; only a freshly signed-in account (no status yet) costs a cloud call.
  private async devices(): Promise<DevicesResponse> {
    const status = await readStatus(this.storagePath);
    if (status && status.updatedAt > 0) {
      return { ...status, stale: Date.now() - status.updatedAt > STALE_AFTER_MS };
    }
    const session = await readSession(this.storagePath);
    if (!session) {
      throw new Error('Not signed in.');
    }
    const fresh = await this.fetchStatus(session);
    await writeStatus(this.storagePath, fresh);
    return { ...fresh, stale: false };
  }

  private async fetchStatus(session: StoredSession): Promise<PlatformStatus> {
    const api = this.apiFor(session.email, session.clientId, session.region);
    const homeId = await api.getHomeId(session.userData);
    const home = await api.getHomeData(session.userData, homeId);
    const devices: StatusDevice[] = findMowers(home).map((mower) => {
      const state = deriveMowerState(Object.fromEntries(Object.entries(mower.deviceStatus ?? {}).map(([k, v]) => [Number(k), v])));
      return {
        duid: mower.duid,
        name: mower.name,
        model: mower.model,
        productName: mower.productName,
        online: mower.online !== false,
        fv: mower.fv,
        mowState: state.mowState,
        mowStateName: describeMowState(state.mowState),
        battery: state.battery,
      };
    });
    return { updatedAt: Date.now(), devices };
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Roborock Mower UI] ${message}`);
      throw new RequestError(message, { status: 400 });
    }
  }
}

new RoborockMowerUiServer();
