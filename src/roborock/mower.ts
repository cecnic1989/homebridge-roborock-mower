import type { HomeData, HomeDataDevice, HomeDataProduct } from './types.js';

export const MOWER_CATEGORY = 'roborock.mower';

export interface MowerDevice extends HomeDataDevice {
  model: string;
  category: string;
  productName?: string;
}

export function findMowers(home: HomeData): MowerDevice[] {
  const products = new Map<string, HomeDataProduct>((home.products ?? []).map((product) => [product.id, product]));
  return [...(home.devices ?? []), ...(home.receivedDevices ?? [])].flatMap((device) => {
    const product = products.get(device.productId);
    if (product?.category !== MOWER_CATEGORY) {
      return [];
    }
    return [{ ...device, model: product.model, category: product.category, productName: product.name }];
  });
}
