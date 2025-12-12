import { SafetyEvent } from '../samsara';
import { SpeedingInterval } from './samsaraSpeeding';

/**
 * Unified event format for merging safety events and speeding intervals.
 */
export type UnifiedEvent = {
  source: 'safety' | 'speeding';
  id: string; // Stable dedup key
  type: string; // e.g. 'severe_speeding', 'harsh_brake', etc.
  occurredAt: string; // ISO timestamp
  endedAt?: string; // ISO timestamp (for intervals)
  severity?: string; // 'SEVERE', etc.
  assetId?: string; // Vehicle/asset ID
  vehicleName?: string; // Vehicle name (for safety events)
  driverId?: string;
  details?: Record<string, any>; // Additional fields
  videoUrl?: string | null;
};

/**
 * Normalize a safety event into UnifiedEvent format.
 */
export function normalizeSafetyEvent(event: SafetyEvent): UnifiedEvent {
  // Extract video URL (same logic as buildSafetyPayload)
  const forward = event.downloadForwardVideoUrl as string | undefined;
  const inward = (event as any).downloadInwardVideoUrl as string | undefined;
  const generic = (event as any).downloadVideoUrl as string | undefined;
  const videoUrl = forward || inward || generic || null;

  // Determine event type from behavior labels or type fields
  let eventType = 'unknown';
  const labels = event.behaviorLabels || [];
  if (labels.length > 0) {
    const labelNames = labels.map((l) => l.name || l.label || '').join(', ');
    eventType = labelNames.toLowerCase().replace(/\s+/g, '_');
  } else {
    eventType =
      (event.type || event.eventType || event.behaviorType || 'unknown')
        .toLowerCase()
        .replace(/\s+/g, '_');
  }

  // Get time (prefer time, then occurredAt, then startTime)
  const occurredAt =
    event.time || event.occurredAt || event.startTime || new Date().toISOString();

  // Build details object with all relevant fields
  const details: Record<string, any> = {
    behaviorLabels: event.behaviorLabels,
    location: event.location,
    maxAccelerationGForce: event.maxAccelerationGForce,
    coachingState: event.coachingState,
  };

  return {
    source: 'safety',
    id: event.id, // Use Samsara event ID as-is
    type: eventType,
    occurredAt,
    severity: event.severity,
    assetId: event.vehicle?.id,
    vehicleName: event.vehicle?.name,
    driverId: event.driverId,
    details,
    videoUrl,
  };
}

/**
 * Normalize a speeding interval into UnifiedEvent format.
 */
export function normalizeSpeedingInterval(
  interval: SpeedingInterval
): UnifiedEvent {
  // Create stable dedup key: speeding:<assetId>:<startTime>:<endTime>
  const id = `speeding:${interval.assetId}:${interval.startTime}:${interval.endTime}`;

  return {
    source: 'speeding',
    id,
    type: 'severe_speeding',
    occurredAt: interval.startTime,
    endedAt: interval.endTime,
    severity: interval.severity?.toUpperCase() || 'SEVERE',
    assetId: interval.assetId,
    driverId: interval.driverId,
    details: {
      maxSpeedMph: interval.maxSpeedMph,
      speedLimitMph: interval.speedLimitMph,
      // Include any other fields from interval
      ...Object.fromEntries(
        Object.entries(interval).filter(
          ([key]) =>
            !['assetId', 'startTime', 'endTime', 'severity', 'driverId'].includes(
              key
            )
        )
      ),
    },
    videoUrl: null, // Speeding intervals typically don't have video
  };
}

/**
 * Normalize multiple safety events.
 */
export function normalizeSafetyEvents(
  events: SafetyEvent[]
): UnifiedEvent[] {
  return events.map(normalizeSafetyEvent);
}

/**
 * Normalize multiple speeding intervals.
 */
export function normalizeSpeedingIntervals(
  intervals: SpeedingInterval[]
): UnifiedEvent[] {
  return intervals.map(normalizeSpeedingInterval);
}

/**
 * Merge and deduplicate unified events.
 * Sorts by occurredAt (oldest first).
 */
export function mergeAndDedupeEvents(
  events: UnifiedEvent[]
): UnifiedEvent[] {
  // Deduplicate by stable ID
  const seen = new Set<string>();
  const unique: UnifiedEvent[] = [];

  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      unique.push(event);
    }
  }

  // Sort by occurredAt (oldest first)
  unique.sort((a, b) => {
    const timeA = new Date(a.occurredAt).getTime();
    const timeB = new Date(b.occurredAt).getTime();
    return timeA - timeB;
  });

  return unique;
}

