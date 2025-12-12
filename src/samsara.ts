import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

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

    const events = res.data?.data || res.data?.safetyEvents || res.data || [];

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