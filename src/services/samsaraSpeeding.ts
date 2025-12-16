import axios from 'axios';
import { getAllVehicleAssetIds } from './samsaraVehicles';
import { isEventSent, markEventSent } from '../repository';

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
 * Window type for time range queries.
 */
type Window = { startTime: string; endTime: string };

/**
 * Expand a time window by ±minutes, returning ISO strings.
 * Ensures startTime <= endTime (clamps if needed).
 * 
 * @param isoStart - Start time as ISO string
 * @param isoEnd - End time as ISO string
 * @param minutes - Minutes to expand by (will expand both directions)
 * @returns Expanded window with ISO string timestamps
 */
function expandWindow(isoStart: string, isoEnd: string, minutes: number): Window {
  const start = new Date(isoStart);
  const end = new Date(isoEnd);
  
  // Expand by ±minutes
  const expandedStart = new Date(start.getTime() - minutes * 60 * 1000);
  const expandedEnd = new Date(end.getTime() + minutes * 60 * 1000);
  
  // Ensure start <= end (clamp)
  const finalStart = expandedStart <= expandedEnd ? expandedStart : expandedEnd;
  const finalEnd = expandedStart <= expandedEnd ? expandedEnd : expandedStart;
  
  return {
    startTime: finalStart.toISOString(),
    endTime: finalEnd.toISOString(),
  };
}

/**
 * Internal helper: Fetch speeding intervals for a specific time window and chunk.
 * Returns the raw intervals found (not filtered by severity).
 */
async function fetchSpeedingIntervalsForWindow(
  token: string,
  window: Window,
  chunk: string[],
  chunkIdx: number,
  totalChunks: number
): Promise<{ records: number; intervals: SpeedingInterval[] }> {
  const allIntervals: SpeedingInterval[] = [];
  let totalRecords = 0;
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = 100; // Safety limit

  while (hasMore && pageCount < maxPages) {
    // Build URLSearchParams with repeated assetIds keys
    const params = new URLSearchParams();
    params.set('startTime', window.startTime);
    params.set('endTime', window.endTime);
    
    // Append each assetId as separate param (repeated keys)
    for (const assetId of chunk) {
      params.append('assetIds', assetId);
    }

    if (cursor) {
      params.set('cursor', cursor);
    }

    const url = `https://api.samsara.com/speeding-intervals/stream`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      params,
    });

    // Parse response: records = payload.data ?? []
    const records = res.data?.data ?? [];
    if (!Array.isArray(records)) {
      console.warn(`[SAMSARA][SPEEDING] Chunk ${chunkIdx + 1}/${totalChunks}: Unexpected response structure`);
      break;
    }

    totalRecords += records.length;

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

      allIntervals.push(flattenedInterval);
    }

    // Check for pagination
    cursor = res.data?.pagination?.nextCursor;
    hasMore = !!cursor && flatIntervals.length > 0;
    pageCount++;
  }

  return {
    records: totalRecords,
    intervals: allIntervals,
  };
}

/**
 * Fetch speeding intervals from Samsara API for all vehicles (or specified assetIds).
 * 
 * Automatically fetches all vehicle asset IDs if not provided.
 * Implements chunking to handle large fleets.
 * 
 * ROBUST WINDOW EXPANSION:
 * - Starts with base window (from/to)
 * - Expands to ±120 minutes minimum
 * - If empty, retries with ±360 minutes
 * - Optionally retries with ±720 minutes (12 hours) as final fallback
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
  const { total, severe } = await fetchSpeedingIntervalsInternal(opts);
  return { total, severe };
}

/**
 * Fetch speeding intervals from Samsara API for a time window and return ALL intervals (no severity filtering).
 * Use this when you want to apply your own definition of “severe” (e.g. >= X mph over limit).
 */
export async function fetchSpeedingIntervalsAll(
  opts: { from: Date; to: Date; assetIds?: string[] }
): Promise<{ total: number; intervals: SpeedingInterval[] }> {
  const { total, intervals } = await fetchSpeedingIntervalsInternal(opts);
  return { total, intervals };
}

async function fetchSpeedingIntervalsInternal(
  opts: { from: Date; to: Date; assetIds?: string[] }
): Promise<{ total: number; intervals: SpeedingInterval[]; severe: SpeedingInterval[] }> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error('❌ SAM_SARA_API_TOKEN is missing in .env');
    return { total: 0, intervals: [], severe: [] };
  }

  // Resolve asset IDs: use provided, or fetch all vehicles, or env override
  let assetIds = opts.assetIds;
  if (!assetIds || assetIds.length === 0) {
    assetIds = await getAllVehicleAssetIds();
  }

  if (assetIds.length === 0) {
    console.warn('[SAMSARA][SPEEDING] No asset IDs available for speeding intervals fetch');
    return { total: 0, intervals: [], severe: [] };
  }

  console.log(`[SAMSARA][SPEEDING] Fetching for ${assetIds.length} vehicles (auto-fetched via /fleet/vehicles)`);

  // Base window from options
  const baseWindow: Window = {
    startTime: opts.from.toISOString(),
    endTime: opts.to.toISOString(),
  };

  // Window expansion strategy: try ±120m, then ±360m, then ±720m
  const expansionStrategies = [
    { minutes: 120, label: '±120m' },
    { minutes: 360, label: '±360m' },
    { minutes: 720, label: '±720m' },
  ];

  // Chunking configuration
  const CHUNK_SIZE = 200;
  const chunks: string[][] = [];
  for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
    chunks.push(assetIds.slice(i, i + CHUNK_SIZE));
  }

  const allFlattenedIntervals: SpeedingInterval[] = [];
  const severeIntervals: SpeedingInterval[] = [];

  // Process each chunk with window expansion
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const assetIdsStr = chunk.slice(0, 3).join(',') + (chunk.length > 3 ? `...(+${chunk.length - 3})` : '');
    
    let chunkIntervals: SpeedingInterval[] = [];
    let chunkRecords = 0;
    let usedWindow: Window | null = null;
    let usedExpansion: string | null = null;

    // Try each expansion strategy until we get data
    for (const strategy of expansionStrategies) {
      const expandedWindow = expandWindow(baseWindow.startTime, baseWindow.endTime, strategy.minutes);
      
      console.log(
        `[SAMSARA][SPEEDING] request assetIds=${assetIdsStr} window=${expandedWindow.startTime}..${expandedWindow.endTime} (${strategy.label})`
      );

      try {
        const result = await fetchSpeedingIntervalsForWindow(
          token,
          expandedWindow,
          chunk,
          chunkIdx + 1,
          chunks.length
        );

        chunkRecords = result.records;
        chunkIntervals = result.intervals;

        const severeCount = chunkIntervals.filter(
          (i) => (i.severityLevel || '').toLowerCase().trim() === 'severe'
        ).length;

        console.log(
          `[SAMSARA][SPEEDING] response records=${chunkRecords} intervals=${chunkIntervals.length} severe=${severeCount} (${strategy.label})`
        );

        // If we got data, use this window and stop retrying
        if (chunkIntervals.length > 0) {
          usedWindow = expandedWindow;
          usedExpansion = strategy.label;
          break;
        } else if (strategy.minutes < 720) {
          // Only log retry if not the last strategy
          console.log(
            `[SAMSARA][SPEEDING] retry with expanded window ${strategy.label} (empty response)`
          );
        }
      } catch (err: any) {
        console.error(
          `[SAMSARA][SPEEDING] Error fetching chunk ${chunkIdx + 1}/${chunks.length} with ${strategy.label}:`,
          err.response?.data || err.message
        );
        // Continue to next expansion strategy
      }
    }

    // Add intervals to collections
    for (const interval of chunkIntervals) {
      allFlattenedIntervals.push(interval);

      // PRIMARY FILTER: Use Samsara's severityLevel === 'severe' (same as fetchSpeedingIntervalsWithSlidingWindow)
      // This is what Samsara AI recommends - they determine severity based on
      // both speed difference AND duration, which we can't replicate accurately
      const severityLevel = (interval.severityLevel || '').toLowerCase().trim();
      const isSevereBySamsara = severityLevel === 'severe';

      if (isSevereBySamsara) {
        severeIntervals.push(interval);
      }
    }

    // Log chunk summary
    const chunkSevereCount = chunkIntervals.filter(
      (i) => (i.severityLevel || '').toLowerCase().trim() === 'severe'
    ).length;
    
    console.log(
      `[SAMSARA][SPEEDING] chunk ${chunkIdx + 1}/${chunks.length}: records=${chunkRecords} intervals=${chunkIntervals.length} severe=${chunkSevereCount} (window: ${usedExpansion || 'none'})`
    );
  }

  // Final summary
  console.log(
    `[SAMSARA][SPEEDING] Total: ${allFlattenedIntervals.length} intervals (all), ${severeIntervals.length} severe, across ${chunks.length} chunk(s)`
  );

  return {
    total: allFlattenedIntervals.length,
    intervals: allFlattenedIntervals,
    severe: severeIntervals,
  };
}

/**
 * Generate dedup key for a speeding interval.
 * Format: ${assetId}:${startTime}:${endTime}
 * 
 * @param interval - Speeding interval
 * @returns Dedup key string
 */
function getSpeedingIntervalDedupKey(interval: SpeedingInterval): string {
  return `${interval.assetId}:${interval.startTime}:${interval.endTime}`;
}

/**
 * Fetch severe speeding intervals using Samsara-recommended sliding window strategy.
 * 
 * Strategy:
 * - Uses a sliding window: windowHours (default 6) + bufferMinutes (default 10)
 * - startTime = now - windowHours - bufferMinutes
 * - endTime = now + 1 minute (to avoid edge misses)
 * - Deduplicates using key: ${assetId}:${startTime}:${endTime}
 * - Returns only new severe intervals (not already sent)
 * 
 * @param opts - Options with optional asset IDs
 * @returns Object with total intervals count, severe intervals count, and new severe intervals to post
 */
export async function fetchSpeedingIntervalsWithSlidingWindow(
  opts: { assetIds?: string[] } = {}
): Promise<{ 
  total: number; 
  severe: number; 
  newToPost: SpeedingInterval[];
  windowStart: string;
  windowEnd: string;
}> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error('❌ SAM_SARA_API_TOKEN is missing in .env');
    return { total: 0, severe: 0, newToPost: [], windowStart: '', windowEnd: '' };
  }

  // Configuration from env vars
  // По умолчанию берём 12 часов окна, как в целевой логике
  const windowHours = parseInt(process.env.SPEEDING_WINDOW_HOURS || '12', 10);
  const bufferMinutes = parseInt(process.env.SPEEDING_BUFFER_MINUTES || '10', 10);

  // Calculate sliding window
  const now = new Date();
  const windowStart = new Date(now.getTime() - (windowHours * 60 + bufferMinutes) * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 1 * 60 * 1000); // +1 minute to avoid edge misses

  const window: Window = {
    startTime: windowStart.toISOString(),
    endTime: windowEnd.toISOString(),
  };

  // Resolve asset IDs
  let assetIds = opts.assetIds;
  if (!assetIds || assetIds.length === 0) {
    assetIds = await getAllVehicleAssetIds();
  }

  if (assetIds.length === 0) {
    console.warn('[SAMSARA][SPEEDING] No asset IDs available for speeding intervals fetch');
    return { total: 0, severe: 0, newToPost: [], windowStart: window.startTime, windowEnd: window.endTime };
  }

  console.log(
    `[SAMSARA][SPEEDING] windowStart=${window.startTime} windowEnd=${window.endTime} (windowHours=${windowHours}, bufferMinutes=${bufferMinutes})`
  );

  // Chunking configuration
  const CHUNK_SIZE = 200;
  const chunks: string[][] = [];
  for (let i = 0; i < assetIds.length; i += CHUNK_SIZE) {
    chunks.push(assetIds.slice(i, i + CHUNK_SIZE));
  }

  const allFlattenedIntervals: SpeedingInterval[] = [];
  const severeIntervals: SpeedingInterval[] = [];

  // Порог по превышению: over = actualSpeed - speedLimit
  // Если over >= threshold → считаем уведомлением
  const overThresholdMph = parseFloat(
    process.env.SPEEDING_OVER_THRESHOLD_MPH || '15',
  );
  console.log(
    `[SAMSARA][SPEEDING] Using over-threshold=${overThresholdMph} mph for alerts`,
  );

  // Process each chunk
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    
    try {
      const result = await fetchSpeedingIntervalsForWindow(
        token,
        window,
        chunk,
        chunkIdx + 1,
        chunks.length
      );

      // Add all intervals
      for (const interval of result.intervals) {
        allFlattenedIntervals.push(interval);

        // Фильтруем по нашему порогу, а не по severityLevel клиента
        const actual = interval.maxSpeedMph;
        const limit = interval.speedLimitMph;
        if (actual != null && limit != null) {
          const over = actual - limit;
          if (over >= overThresholdMph) {
            severeIntervals.push(interval);
          }
        }
      }
    } catch (err: any) {
      console.error(
        `[SAMSARA][SPEEDING] Error fetching chunk ${chunkIdx + 1}/${chunks.length}:`,
        err.response?.data || err.message
      );
      // Continue with next chunk
    }
  }

  // Deduplicate: check which severe intervals are new (not already sent)
  const newToPost: SpeedingInterval[] = [];
  for (const interval of severeIntervals) {
    const dedupKey = getSpeedingIntervalDedupKey(interval);
    // Use the same format as normalizeSpeedingInterval for consistency
    const eventId = `speeding:${dedupKey}`;
    
    const alreadySent = await isEventSent(eventId);
    if (!alreadySent) {
      newToPost.push(interval);
    }
  }

  console.log(
    `[SAMSARA][SPEEDING] totalIntervals=${allFlattenedIntervals.length} severe=${severeIntervals.length} newToPost=${newToPost.length}`
  );

  return {
    total: allFlattenedIntervals.length,
    severe: severeIntervals.length,
    newToPost,
    windowStart: window.startTime,
    windowEnd: window.endTime,
  };
}

