import axios from 'axios';

/**
 * Speeding interval from Samsara API.
 * Based on /speeding-intervals/stream endpoint.
 */
export type SpeedingInterval = {
  assetId: string;
  startTime: string;
  endTime: string;
  severity?: string;
  maxSpeedMph?: number;
  speedLimitMph?: number;
  driverId?: string;
  // Additional fields that may be present
  [key: string]: any;
};

// In-memory cache for asset IDs (10 minute TTL)
let assetIdsCache: { ids: string[]; expiresAt: number } | null = null;
const ASSET_IDS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get asset IDs from environment or fetch from Samsara.
 * Falls back to SAMSARA_ASSET_IDS env var if available.
 * 
 * @returns Array of asset IDs
 */
async function getAssetIds(): Promise<string[]> {
  // Check cache first
  if (assetIdsCache && assetIdsCache.expiresAt > Date.now()) {
    return assetIdsCache.ids;
  }

  // Try to fetch from Samsara API (if we have a way to list assets)
  // For now, fall back to environment variable
  const envAssetIds = process.env.SAM_SARA_ASSET_IDS;
  if (envAssetIds) {
    const ids = envAssetIds
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    
    if (ids.length > 0) {
      // Cache the result
      assetIdsCache = {
        ids,
        expiresAt: Date.now() + ASSET_IDS_CACHE_TTL_MS,
      };
      console.log(`[SAMSARA] Using ${ids.length} asset IDs from SAMSARA_ASSET_IDS env var`);
      return ids;
    }
  }

  // If no asset IDs available, log warning and return empty
  console.warn(
    '[SAMSARA] No asset IDs available. Set SAMSARA_ASSET_IDS env var (comma-separated) or implement asset listing.'
  );
  return [];
}

/**
 * Fetch speeding intervals from Samsara API.
 * 
 * Endpoint: GET https://api.samsara.com/speeding-intervals/stream
 * 
 * Handles pagination/streaming as required by Samsara.
 * Filters for Severe Speeding (severity === 'SEVERE' or 'severe').
 * 
 * @param opts - Options with time window and optional asset IDs
 * @returns Array of speeding intervals (only SEVERE ones)
 */
export async function fetchSpeedingIntervals(
  opts: { from: Date; to: Date; assetIds?: string[] }
): Promise<SpeedingInterval[]> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error('❌ SAM_SARA_API_TOKEN is missing in .env');
    return [];
  }

  // Get asset IDs
  let assetIds = opts.assetIds;
  if (!assetIds || assetIds.length === 0) {
    assetIds = await getAssetIds();
  }

  if (assetIds.length === 0) {
    console.warn('[SAMSARA] No asset IDs available for speeding intervals fetch');
    return [];
  }

  const allIntervals: SpeedingInterval[] = [];
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = 100; // Safety limit

  try {
    while (hasMore && pageCount < maxPages) {
      const params: Record<string, any> = {
        startTime: opts.from.toISOString(),
        endTime: opts.to.toISOString(),
        assetIds: assetIds.join(','),
        limit: 100, // Max per page
      };

      if (cursor) {
        params.cursor = cursor;
      }

      const res = await axios.get(
        'https://api.samsara.com/speeding-intervals/stream',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          params,
        }
      );

      const data = res.data?.data || res.data || [];
      const intervals: SpeedingInterval[] = Array.isArray(data) ? data : [];

      // Filter for SEVERE severity (case-insensitive)
      const severeIntervals = intervals.filter((interval) => {
        const severity = (interval.severity || '').toUpperCase();
        return severity === 'SEVERE';
      });

      allIntervals.push(...severeIntervals);

      // Check for pagination
      cursor = res.data?.pagination?.nextCursor;
      hasMore = !!cursor && intervals.length > 0;

      pageCount++;

      // Log progress
      if (pageCount === 1) {
        console.log(
          `[SAMSARA] Fetched ${intervals.length} speeding intervals (${severeIntervals.length} severe) from page ${pageCount}`
        );
      }
    }

    console.log(
      `[SAMSARA] Total speeding intervals fetched: ${allIntervals.length} (severe only) across ${pageCount} page(s)`
    );

    if (allIntervals.length === 0 && assetIds.length > 0) {
      console.log(
        `[SAMSARA] No severe speeding intervals found. Asset IDs used: ${assetIds.join(', ')}`
      );
    }

    return allIntervals;
  } catch (err: any) {
    console.error(
      '❌ Error fetching speeding intervals:',
      err.response?.data || err.message
    );
    return [];
  }
}

