import axios from 'axios';

/**
 * Speeding interval from Samsara API.
 * Based on /speeding-intervals/stream endpoint.
 * 
 * Note: API returns data[].intervals[] structure, where each interval
 * has severityLevel (not severity) and speeds in km/h.
 */
export type SpeedingInterval = {
  assetId: string;
  startTime: string;
  endTime: string;
  severityLevel?: string; // 'light' | 'moderate' | 'severe'
  maxSpeedMph?: number; // Converted from maxSpeedKilometersPerHour
  speedLimitMph?: number; // Converted from postedSpeedLimitKilometersPerHour
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
 * Convert kilometers per hour to miles per hour.
 */
function kmhToMph(kmh: number | null | undefined): number | undefined {
  if (kmh == null) return undefined;
  return Math.round((kmh * 0.621371) * 10) / 10; // Round to 1 decimal
}

/**
 * Fetch speeding intervals from Samsara API.
 * 
 * Endpoint: GET https://api.samsara.com/speeding-intervals/stream
 * 
 * Response structure:
 * {
 *   data: [
 *     {
 *       asset: { id },
 *       intervals: [
 *         {
 *           severityLevel: "light|moderate|severe",
 *           startTime,
 *           endTime,
 *           postedSpeedLimitKilometersPerHour,
 *           maxSpeedKilometersPerHour,
 *           ...
 *         }
 *       ]
 *     }
 *   ]
 * }
 * 
 * Handles pagination/streaming as required by Samsara.
 * Filters for Severe Speeding (severityLevel === 'severe').
 * 
 * @param opts - Options with time window and optional asset IDs
 * @returns Object with total intervals count and severe intervals array
 */
export async function fetchSpeedingIntervals(
  opts: { from: Date; to: Date; assetIds?: string[] }
): Promise<{ total: number; severe: SpeedingInterval[] }> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error('❌ SAM_SARA_API_TOKEN is missing in .env');
    return { total: 0, severe: [] };
  }

  // Get asset IDs
  let assetIds = opts.assetIds;
  if (!assetIds || assetIds.length === 0) {
    assetIds = await getAssetIds();
  }

  if (assetIds.length === 0) {
    console.warn('[SAMSARA] No asset IDs available for speeding intervals fetch');
    return { total: 0, severe: [] };
  }

  const allFlattenedIntervals: SpeedingInterval[] = [];
  const severeIntervals: SpeedingInterval[] = [];
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = 100; // Safety limit

  // Track totals across all pages
  let totalRecordsCount = 0;
  let totalIntervalsCount = 0;
  let totalSevereCount = 0;

  try {
    while (hasMore && pageCount < maxPages) {
      // Build params exactly as Insomnia: assetIds as string (comma-separated if multiple)
      const params: Record<string, any> = {
        startTime: opts.from.toISOString(),
        endTime: opts.to.toISOString(),
        assetIds: assetIds.length === 1 ? assetIds[0] : assetIds.join(','), // Plain string for single, comma-separated for multiple
      };

      if (cursor) {
        params.cursor = cursor;
      }

      const url = 'https://api.samsara.com/speeding-intervals/stream';
      
      // Log request details (no secrets)
      console.log(`[SAMSARA] Request URL: ${url}`);
      console.log(`[SAMSARA] Request params:`, {
        startTime: params.startTime,
        endTime: params.endTime,
        assetIds: params.assetIds,
        cursor: params.cursor ? 'present' : 'none',
      });

      const res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        params,
      });

      // Log response status
      console.log(`[SAMSARA] Response status: ${res.status}`);

      // Parse response: data is an array of { asset: { id }, intervals: [...] }
      const dataArray = res.data?.data || [];
      if (!Array.isArray(dataArray)) {
        console.warn('[SAMSARA] Unexpected response structure, data is not an array');
        console.warn('[SAMSARA] Response keys:', Object.keys(res.data || {}));
        break;
      }

      if (dataArray.length === 0 && pageCount === 0) {
        console.log('[SAMSARA] No data records returned from API');
      }

      // Flatten: extract intervals from each data item and attach assetId
      let recordsCount = 0;
      let intervalsCount = 0;
      let severeCountThisPage = 0;
      
      for (const dataItem of dataArray) {
        recordsCount++;
        const assetId = dataItem?.asset?.id;
        const intervals = dataItem?.intervals || [];
        
        if (!assetId) {
          console.warn('[SAMSARA] Missing asset.id in data item');
          continue;
        }

        if (!Array.isArray(intervals)) {
          console.warn(`[SAMSARA] intervals is not an array for asset ${assetId}, type: ${typeof intervals}`);
          continue;
        }

        for (const interval of intervals) {
          intervalsCount++;
          
          // Convert speeds from km/h to mph
          const maxSpeedMph = kmhToMph(interval.maxSpeedKilometersPerHour);
          const speedLimitMph = kmhToMph(interval.postedSpeedLimitKilometersPerHour);

          // Create flattened interval with assetId attached
          const flattenedInterval: SpeedingInterval = {
            assetId: String(assetId), // Ensure string
            startTime: interval.startTime,
            endTime: interval.endTime,
            severityLevel: interval.severityLevel,
            maxSpeedMph,
            speedLimitMph,
            driverId: interval.driverId,
            // Include all other fields
            ...Object.fromEntries(
              Object.entries(interval).filter(
                ([key]) =>
                  ![
                    'startTime',
                    'endTime',
                    'severityLevel',
                    'maxSpeedKilometersPerHour',
                    'postedSpeedLimitKilometersPerHour',
                    'driverId',
                  ].includes(key)
              )
            ),
          };

          allFlattenedIntervals.push(flattenedInterval);

          // Filter for severe (severityLevel === 'severe', case-insensitive)
          const severityLevel = (interval.severityLevel || '').toLowerCase().trim();
          if (severityLevel === 'severe') {
            severeIntervals.push(flattenedInterval);
            severeCountThisPage++;
          }
        }
      }

      // Update totals
      totalRecordsCount += recordsCount;
      totalIntervalsCount += intervalsCount;
      totalSevereCount += severeCountThisPage;

      // Log debug info per page
      console.log(
        `[SAMSARA] Page ${pageCount + 1}: ${recordsCount} records, ${intervalsCount} intervals (${severeCountThisPage} severe this page)`
      );

      // Check for pagination
      cursor = res.data?.pagination?.nextCursor;
      hasMore = !!cursor && intervalsCount > 0;

      pageCount++;
    }

    // Final debug logs
    console.log(
      `[SAMSARA] Final counts: records=${totalRecordsCount}, intervals (total)=${totalIntervalsCount}, severe=${totalSevereCount}, across ${pageCount} page(s)`
    );
    console.log(
      `[SAMSARA] Asset IDs queried: ${assetIds.join(', ')}`
    );

    if (allFlattenedIntervals.length === 0 && assetIds.length > 0) {
      console.log(
        `[SAMSARA] No intervals returned. Check asset IDs match Samsara asset IDs and time window.`
      );
    } else if (severeIntervals.length === 0 && allFlattenedIntervals.length > 0) {
      console.log(
        `[SAMSARA] Found ${allFlattenedIntervals.length} intervals but none are severe.`
      );
    } else if (severeIntervals.length > 0) {
      // Log sample severe interval for debugging
      const sample = severeIntervals[0];
      console.log(
        `[SAMSARA] Sample severe interval: assetId=${sample.assetId}, startTime=${sample.startTime}, severityLevel=${sample.severityLevel}`
      );
    }

    return {
      total: allFlattenedIntervals.length,
      severe: severeIntervals,
    };
  } catch (err: any) {
    console.error(
      '❌ Error fetching speeding intervals:',
      err.response?.data || err.message
    );
    return { total: 0, severe: [] };
  }
}

