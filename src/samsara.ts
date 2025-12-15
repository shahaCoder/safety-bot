import axios from "axios";
// dotenv is loaded in entrypoint (src/index.ts), no need to load here

export interface SafetyEvent {
  id: string;
  time?: string;
  occurredAt?: string; // Alternative time field
  startTime?: string; // Alternative time field
  vehicle?: {
    id?: string;
    name?: string;
    externalIds?: {
      'samsara.serial'?: string;
      'samsara.vin'?: string;
    };
  };
  maxAccelerationGForce?: number;
  downloadForwardVideoUrl?: string;
  downloadInwardVideoUrl?: string;
  downloadVideoUrl?: string;
  mediaUrl?: string; // Alternative video URL field
  videoUrl?: string; // Alternative video URL field
  location?: {
    latitude?: number;
    longitude?: number;
  };
  coachingState?: string;
  behaviorLabels?: {
    label?: string; // machine label, e.g. "followingDistance"
    name?: string;  // human readable, e.g. "Following Distance"
    source?: string;
  }[];
  // Additional fields for debug/diagnostics
  type?: string;
  eventType?: string;
  behaviorType?: string;
  severity?: string;
  driverId?: string;
  [key: string]: any; // Allow additional fields from Samsara API
}


export async function getRecentSafetyEvents(
  lookbackMinutes: number = 60
): Promise<SafetyEvent[]> {
  const now = new Date();
  const since = new Date(now.getTime() - lookbackMinutes * 60 * 1000);
  return getSafetyEventsInWindow({ from: since, to: now });
}

/**
 * Fetch safety events for a custom time window.
 * Used by debug command and can be reused by cron if needed.
 * 
 * @param window - Time window with from and to dates
 * @param limit - Maximum number of events to return (default: 100 for debug)
 * @returns Array of safety events
 */
export async function getSafetyEventsInWindow(
  window: { from: Date; to: Date },
  limit: number = 100
): Promise<SafetyEvent[]> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error("❌ SAM_SARA_API_TOKEN is missing in .env");
    return [];
  }

  try {
    const res = await axios.get("https://api.samsara.com/fleet/safety-events", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        startTime: window.from.toISOString(),
        endTime: window.to.toISOString(),
        limit,
      },
    });

    const raw = res.data;

    // Detailed debug logging for cron: show exact JSON shape from Samsara
    try {
      const keys =
        raw && typeof raw === "object" ? Object.keys(raw) : ["<non-object>"];
      console.log(
        "[SAMSARA][SAFETY][RAW_RESPONSE_KEYS]",
        JSON.stringify(keys),
      );

      const sampleEvent =
        raw?.data?.[0] ??
        raw?.safetyEvents?.[0] ??
        (Array.isArray(raw) ? raw[0] : raw);

      console.log(
        "[SAMSARA][SAFETY][RAW_SAMPLE_EVENT]",
        JSON.stringify(sampleEvent, null, 2),
      );
    } catch (logErr) {
      console.log(
        "[SAMSARA][SAFETY][RAW_LOG_ERROR]",
        (logErr as any)?.message ?? logErr,
      );
    }

    const events = raw?.data || raw?.safetyEvents || raw || [];

    console.log(`🛰 Samsara returned ${events.length} events for window ${window.from.toISOString()} to ${window.to.toISOString()}`);
    return events;
  } catch (err: any) {
    console.error(
      "❌ Error fetching safety events:",
      err.response?.data || err.message
    );
    return [];
  }
}

/**
 * Fetch media URL for a safety event by doing a lookup query.
 * 
 * Samsara API doesn't always return media URLs in the feed, but they may be available
 * through a targeted lookup query with a time window around the event.
 * 
 * This implements the enterprise integration pattern: if media is missing in feed,
 * perform a lookup query to find it.
 * 
 * @param event - Safety event with vehicle.id and time fields
 * @returns Video URL (forward > inward > rear) or undefined if not found
 */
export async function fetchSafetyEventMedia(
  event: { vehicle?: { id?: string }; time?: string; occurredAt?: string; id?: string }
): Promise<{ videoUrl?: string }> {
  const token = process.env.SAM_SARA_API_TOKEN;
  const eventId = event.id || 'unknown';
  const vehicleId = event.vehicle?.id;
  const eventTime = event.time || event.occurredAt;

  if (!token) {
    console.error(`[MEDIA_LOOKUP] eventId=${eventId} - SAM_SARA_API_TOKEN missing`);
    return {};
  }

  if (!vehicleId || !eventTime) {
    console.log(`[MEDIA_LOOKUP] eventId=${eventId} - Missing vehicle.id or time, skipping lookup`);
    return {};
  }

  try {
    // Create ±5 minute window around event time
    const eventDate = new Date(eventTime);
    const windowStart = new Date(eventDate.getTime() - 5 * 60 * 1000); // -5 minutes
    const windowEnd = new Date(eventDate.getTime() + 5 * 60 * 1000);   // +5 minutes

    console.log(`[MEDIA_LOOKUP] eventId=${eventId} window=±5min (${windowStart.toISOString()} to ${windowEnd.toISOString()})`);

    const res = await axios.get("https://api.samsara.com/fleet/safety-events", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        startTime: windowStart.toISOString(),
        endTime: windowEnd.toISOString(),
        vehicleIds: vehicleId,
        limit: 100, // Should be enough to find the event
      },
    });

    const events = res.data?.data || res.data?.safetyEvents || res.data || [];

    // Find the matching event by ID (if available) or by time proximity
    let matchedEvent: SafetyEvent | null = null;
    
    if (event.id) {
      // Try to find by exact ID first
      matchedEvent = events.find((e: SafetyEvent) => e.id === event.id) || null;
    }
    
    if (!matchedEvent) {
      // Fallback: find event with closest time to original event
      const eventTimeMs = eventDate.getTime();
      let closestDiff = Infinity;
      for (const e of events) {
        const eTime = e.time || e.occurredAt || e.startTime;
        if (eTime) {
          const diff = Math.abs(new Date(eTime).getTime() - eventTimeMs);
          if (diff < closestDiff) {
            closestDiff = diff;
            matchedEvent = e;
          }
        }
      }
    }

    if (!matchedEvent) {
      console.log(`[MEDIA_LOOKUP] eventId=${eventId} found=false (no matching event in window)`);
      return {};
    }

    // Extract video URL with priority: forward > inward > rear > generic
    const forward = matchedEvent.downloadForwardVideoUrl as string | undefined;
    const inward = (matchedEvent as any).downloadInwardVideoUrl as string | undefined;
    const rear = (matchedEvent as any).downloadRearVideoUrl as string | undefined;
    const generic = (matchedEvent as any).downloadVideoUrl as string | undefined;

    const videoUrl = forward || inward || rear || generic;

    if (videoUrl) {
      const selected = forward ? 'forward' : inward ? 'inward' : rear ? 'rear' : 'generic';
      console.log(`[MEDIA_LOOKUP] eventId=${eventId} found=true selected=${selected}`);
      return { videoUrl };
    } else {
      console.log(`[MEDIA_LOOKUP] eventId=${eventId} found=true selected=none (no media URLs in matched event)`);
      return {};
    }
  } catch (err: any) {
    console.error(
      `[MEDIA_LOOKUP] eventId=${eventId} - Error during lookup:`,
      err.response?.data || err.message
    );
    return {};
  }
}