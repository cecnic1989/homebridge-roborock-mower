import { randomUUID } from 'node:crypto';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { findMowers } from '../roborock/mower.js';
import { clearSession, readSession, writeSession } from '../roborock/session-store.js';
import type { RegionInfo } from '../roborock/types.js';
import { RoborockWebApi } from '../roborock/web-api.js';

interface SendCodePayload {
  email: string;
}

interface VerifyCodePayload extends SendCodePayload {
  clientId: string;
  region: RegionInfo;
  code: string;
}

class RoborockMowerUiServer extends HomebridgePluginUiServer {
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

  private async session(): Promise<{ email: string | null }> {
    const session = await readSession(this.storagePath);
    return { email: session?.email ?? null };
  }

  private async sendCode({ email }: SendCodePayload) {
    const clientId = randomUUID();
    const api = new RoborockWebApi({ email, clientId });
    const region = await api.requestEmailCode();
    return { clientId, region };
  }

  private async verifyCode({ email, clientId, region, code }: VerifyCodePayload): Promise<{ email: string }> {
    const api = new RoborockWebApi({ email, clientId, region });
    const userData = await api.loginWithCode(code.trim());
    await writeSession(this.storagePath, { email, clientId, region, userData });
    return { email };
  }

  private async signOut(): Promise<void> {
    await clearSession(this.storagePath);
  }

  private async devices() {
    const session = await readSession(this.storagePath);
    if (!session) {
      throw new Error('Not signed in.');
    }
    const api = new RoborockWebApi({ email: session.email, clientId: session.clientId, region: session.region });
    const homeId = await api.getHomeId(session.userData);
    const home = await api.getHomeData(session.userData, homeId);
    const mowers = findMowers(home);
    const total = (home.devices?.length ?? 0) + (home.receivedDevices?.length ?? 0);
    return { mowers, otherDeviceCount: total - mowers.length };
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
