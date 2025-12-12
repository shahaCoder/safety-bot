import axios from 'axios';

// In-memory cache for vehicles (10 minute TTL)
let vehiclesCache: { vehicles: VehicleInfo[]; expiresAt: number } | null = null;
const VEHICLES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type VehicleInfo = {
  id: string;
  name?: string;
  [key: string]: any;
};

/**
 * Fetch all vehicles from Samsara API.
 * 
 * Endpoint: GET https://api.samsara.com/fleet/vehicles
 * 
 * @returns Array of vehicle info with id and name
 */
async function fetchAllVehicles(): Promise<VehicleInfo[]> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error('❌ SAM_SARA_API_TOKEN is missing in .env');
    return [];
  }

  try {
    const res = await axios.get('https://api.samsara.com/fleet/vehicles', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const vehicles = res.data?.data || [];
    console.log(`[SAMSARA] vehicles fetched: ${vehicles.length}`);
    return vehicles;
  } catch (err: any) {
    console.error(
      '❌ Error fetching vehicles:',
      err.response?.data || err.message
    );
    return [];
  }
}

/**
 * Get all vehicle asset IDs with caching.
 * 
 * Optional env override: If SAMSARA_ASSET_IDS is set, use it instead of fetching.
 * 
 * @returns Array of vehicle/asset IDs
 */
export async function getAllVehicleAssetIds(): Promise<string[]> {
  // Check for env override first
  const envOverride = process.env.SAMSARA_ASSET_IDS;
  if (envOverride) {
    const ids = envOverride
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      console.log(`[SAMSARA] Using SAMSARA_ASSET_IDS env override: ${ids.length} IDs`);
      return ids;
    }
  }

  // Check cache
  if (vehiclesCache && vehiclesCache.expiresAt > Date.now()) {
    console.log(`[SAMSARA] vehicles cache hit: ${vehiclesCache.vehicles.length}`);
    return vehiclesCache.vehicles.map((v) => v.id);
  }

  // Cache miss - fetch from API
  console.log('[SAMSARA] vehicles cache miss, fetching from API...');
  const vehicles = await fetchAllVehicles();

  if (vehicles.length > 0) {
    // Cache the result
    vehiclesCache = {
      vehicles,
      expiresAt: Date.now() + VEHICLES_CACHE_TTL_MS,
    };
  }

  return vehicles.map((v) => v.id);
}

/**
 * Get vehicle name by asset ID (from cache if available).
 * 
 * @param assetId - Vehicle/asset ID
 * @returns Vehicle name or null
 */
export function getVehicleNameById(assetId: string): string | null {
  if (!vehiclesCache || vehiclesCache.expiresAt <= Date.now()) {
    return null;
  }

  const vehicle = vehiclesCache.vehicles.find((v) => v.id === assetId);
  return vehicle?.name || null;
}

/**
 * Get all vehicles info (for mapping assetId to name).
 * 
 * @returns Array of vehicle info
 */
export async function getAllVehiclesInfo(): Promise<VehicleInfo[]> {
  // Check cache
  if (vehiclesCache && vehiclesCache.expiresAt > Date.now()) {
    return vehiclesCache.vehicles;
  }

  // Fetch if cache miss
  const vehicles = await fetchAllVehicles();
  if (vehicles.length > 0) {
    vehiclesCache = {
      vehicles,
      expiresAt: Date.now() + VEHICLES_CACHE_TTL_MS,
    };
  }

  return vehicles;
}

