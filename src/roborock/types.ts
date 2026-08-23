export interface RRiotReference {
  a?: string | null; // Hawk-authenticated API host
  m?: string | null; // MQTT broker URL
  l?: string | null;
  r?: string | null;
}

export interface RRiot {
  u: string; // user id
  s: string; // Hawk secret
  h: string; // HMAC key
  k: string; // MQTT key material
  r: RRiotReference;
}

export interface UserData {
  token: string;
  rruid?: string;
  region?: string;
  country?: string;
  countrycode?: string;
  nickname?: string;
  rriot: RRiot;
}

export interface RegionInfo {
  baseUrl: string;
  country: string;
  countryCode: string;
}

export interface StoredSession {
  email: string;
  clientId: string;
  region: RegionInfo;
  userData: UserData;
}

export interface HomeDataDevice {
  duid: string;
  name: string;
  productId: string;
  localKey?: string;
  pv?: string;
  online?: boolean;
  sn?: string;
  fv?: string;
  deviceStatus?: Record<string, unknown>;
}

export interface HomeDataProduct {
  id: string;
  name?: string;
  model: string;
  category?: string;
}

export interface HomeData {
  id: number;
  name?: string;
  products: HomeDataProduct[];
  devices: HomeDataDevice[];
  receivedDevices: HomeDataDevice[];
}

export class RoborockApiError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = 'RoborockApiError';
  }
}
