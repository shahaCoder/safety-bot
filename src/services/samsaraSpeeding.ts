import axios from 'axios';
import { getAllVehicleAssetIds } from './samsaraVehicles';

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

// Legacy function - kept for backward compatibility but now uses getAllVehicleAssetIds
async function getAssetIds(): Promise<string[]> {
  return getAllVehicleAssetIds();
}

/**
 * Convert kilometers per hour to miles per hour.
 */
function kmhToMph(kmh: number | null | undefined): number | undefined {
  if (kmh == null) return undefined;
  return Math.round((kmh * 0.621371) * 10) / 10; // Round to 1 decimal
}

/**
 * Fetch speeding intervals from Samsara API for all vehicles (or specified assetIds).
 * 
 * Automatically fetches all vehicle asset IDs if not provided.
 * Implements chunking to handle large fleets.
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
 *           location: { address: "..." },
 *           ...
 *         }
 *       ]
 *     }
 *   ]
 * }
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

  // Resolve asset IDs: use provided, or fetch all vehicles, or env override
  let assetIds = opts.assetIds;
  const useEnvOverride = !!process.env.SAMSARA_ASSET_IDS;
  
  if (!assetIds || assetIds.length === 0) {
    assetIds = await getAllVehicleAssetIds();
  }

  if (assetIds.length === 0) {
    console.warn('[SAMSARA] No asset IDs available for speeding intervals fetch');
    return { total: 0, severe: [] };
  }

  console.log(`[SAMSARA] Fetching speeding intervals for ${assetIds.length} vehicles (mode: ${useEnvOverride ? 'env override' : 'auto-fetched'})`);

  // Chunking configuration
  const CHUNK_SIZE = 200; // Configurable chunk size
  const chunks: string[][] = [];
  for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
    chunks.push(assetIds.slice(i, i + CHUNK_SIZE));
  }

  const allFlattenedIntervals: SpeedingInterval[] = [];
  const severeIntervals: SpeedingInterval[] = [];

  // Process each chunk
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    
    try {
      let cursor: string | undefined = undefined;
      let hasMore = true;
      let pageCount = 0;
      const maxPages = 100; // Safety limit

      let chunkRecordsCount = 0;
      let chunkIntervalsCount = 0;
      let chunkSevereCount = 0;

      while (hasMore && pageCount < maxPages) {
        // Build URLSearchParams with repeated assetIds keys
        const params = new URLSearchParams();
        params.set('startTime', opts.from.toISOString());
        params.set('endTime', opts.to.toISOString());
        
        // Append each assetId as separate param (repeated keys)
        for (const assetId of chunk) {
          params.append('assetIds', assetId);
        }

        if (cursor) {
          params.set('cursor', cursor);
        }

        const url = `https://api.samsara.com/speeding-intervals/stream?${params.toString()}`;

        const res = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });

        // Parse response: records = payload.data ?? []
        const records = res.data?.data ?? [];
        if (!Array.isArray(records)) {
          console.warn(`[SAMSARA] Chunk ${chunkIdx + 1}/${chunks.length}: Unexpected response structure`);
          break;
        }

        // Flatten: flatIntervals = records.flatMap(r => (r.intervals ?? []).map(i => ({...i, assetId: r.asset.id})))
        const flatIntervals = records.flatMap((r: any) => {
          const intervals = r.intervals ?? [];
          const assetId = r.asset?.id;
          if (!assetId) return [];
          
          return intervals.map((i: any) => ({
            ...i,
            assetId: String(assetId),
          }));
        });

        chunkRecordsCount += records.length;
        chunkIntervalsCount += flatIntervals.length;

        // Convert and add to all intervals
        for (const interval of flatIntervals) {
          const maxSpeedMph = kmhToMph(interval.maxSpeedKilometersPerHour);
          const speedLimitMph = kmhToMph(interval.postedSpeedLimitKilometersPerHour);

          const flattenedInterval: SpeedingInterval = {
            assetId: String(interval.assetId),
            startTime: interval.startTime,
            endTime: interval.endTime,
            severityLevel: interval.severityLevel,
            maxSpeedMph,
            speedLimitMph,
            driverId: interval.driverId,
            // Include location and other fields
            ...Object.fromEntries(
              Object.entries(interval).filter(
                ([key]) =>
                  ![
                    'assetId',
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

          // Filter for severe: severityLevel?.toLowerCase() === 'severe'
          const severityLevel = (interval.severityLevel || '').toLowerCase().trim();
          if (severityLevel === 'severe') {
            severeIntervals.push(flattenedInterval);
            chunkSevereCount++;
          }
        }

        // Check for pagination
        cursor = res.data?.pagination?.nextCursor;
        hasMore = !!cursor && flatIntervals.length > 0;
        pageCount++;
      }

      // Log chunk results
      console.log(
        `[SAMSARA] speeding chunk ${chunkIdx + 1}/${chunks.length}: records=${chunkRecordsCount} intervals=${chunkIntervalsCount} severe=${chunkSevereCount}`
      );
    } catch (err: any) {
      console.error(
        `❌ Error fetching speeding intervals chunk ${chunkIdx + 1}/${chunks.length}:`,
        err.response?.data || err.message
      );
      // Continue with next chunk instead of failing completely
    }
  }

  // Final summary
  console.log(
    `[SAMSARA] Total: ${allFlattenedIntervals.length} intervals (all), ${severeIntervals.length} severe, across ${chunks.length} chunk(s)`
  );

  return {
    total: allFlattenedIntervals.length,
    severe: severeIntervals,
  };
}

