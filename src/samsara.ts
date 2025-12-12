import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

export interface SafetyEvent {
  id: string;
  time?: string;
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
}


export async function getRecentSafetyEvents(
  lookbackMinutes: number = 60
): Promise<SafetyEvent[]> {
  const token = process.env.SAM_SARA_API_TOKEN;

  if (!token) {
    console.error("❌ SAM_SARA_API_TOKEN is missing in .env");
    return [];
  }

  const now = new Date();
  const since = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  try {
    const res = await axios.get("https://api.samsara.com/fleet/safety-events", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        startTime: since.toISOString(),
        endTime: now.toISOString(),
        limit: 50,
      },
    });

    const events = res.data?.data || res.data?.safetyEvents || res.data || [];

    console.log(`🛰 Samsara returned ${events.length} events`);
    console.log("📦 Raw Samsara events:", JSON.stringify(events, null, 2));
    return events;
  } catch (err: any) {
    console.error(
      "❌ Error fetching safety events:",
      err.response?.data || err.message
    );
    return [];
  }
}