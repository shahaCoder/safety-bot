import { Context } from 'telegraf';
import { getSafetyEventsInWindow, SafetyEvent } from '../samsara';
import { fetchSpeedingIntervals, fetchSpeedingIntervalsWithSlidingWindow, SpeedingInterval } from '../services/samsaraSpeeding';
import { getAllVehicleAssetIds } from '../services/samsaraVehicles';
import {
  normalizeSafetyEvents,
  normalizeSpeedingIntervals,
  mergeAndDedupeEvents,
  UnifiedEvent,
} from '../services/eventNormalize';

/**
 * Normalize event type by checking multiple possible fields.
 * Samsara may use different field names for the same concept.
 */
function normalizeEventType(event: SafetyEvent): string {
  // Check multiple possible fields
  const type = event.type || event.eventType || event.behaviorType || '';
  const labels = event.behaviorLabels || [];
  const labelNames = labels.map((l) => l.name || l.label || '').join(', ');
  
  // Combine all type indicators
  const allTypes = [type, labelNames]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return allTypes || 'unknown';
}

/**
 * Check if event represents "Severe Speeding" by examining multiple fields.
 * Samsara UI label "Severe Speeding" may not equal API field value.
 */
function isSevereSpeeding(event: SafetyEvent): boolean {
  const normalized = normalizeEventType(event);
  const severity = (event.severity || '').toLowerCase();
  
  // Check normalized type
  const hasSevereSpeeding = 
    normalized.includes('severe speed') ||
    normalized.includes('severe speeding') ||
    normalized.includes('severespeeding') ||
    (normalized.includes('speed') && severity.includes('severe'));

  // Check severity field
  const hasSevereSeverity = severity.includes('severe');

  // Check behavior labels
  const labels = event.behaviorLabels || [];
  const hasSevereLabel = labels.some((l) => {
    const name = (l.name || '').toLowerCase();
    const label = (l.label || '').toLowerCase();
    return (
      name.includes('severe speed') ||
      name.includes('severe speeding') ||
      label.includes('severespeed') ||
      label.includes('severe_speed')
    );
  });

  return hasSevereSpeeding || (hasSevereSeverity && normalized.includes('speed')) || hasSevereLabel;
}

/**
 * Extract video/media URL from event (checking multiple possible fields).
 */
function getVideoUrl(event: SafetyEvent): string | null {
  return (
    event.downloadForwardVideoUrl ||
    event.downloadInwardVideoUrl ||
    event.downloadVideoUrl ||
    event.mediaUrl ||
    event.videoUrl ||
    null
  );
}

/**
 * Get event time from multiple possible fields.
 */
function getEventTime(event: SafetyEvent): string | null {
  return event.time || event.occurredAt || event.startTime || null;
}

/**
 * Count event types and return top N by frequency.
 */
function getTopEventTypes(events: SafetyEvent[], topN: number = 5): Array<{ type: string; count: number }> {
  const typeCounts = new Map<string, number>();

  for (const event of events) {
    const normalized = normalizeEventType(event);
    const current = typeCounts.get(normalized) || 0;
    typeCounts.set(normalized, current + 1);
  }

  return Array.from(typeCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Find example Severe Speeding event, or any speeding event if none found.
 */
function findExampleSevereSpeedingEvent(events: SafetyEvent[]): SafetyEvent | null {
  // First, try to find actual Severe Speeding
  const severeSpeeding = events.find(isSevereSpeeding);
  if (severeSpeeding) {
    return severeSpeeding;
  }

  // Fallback: find any speeding event
  const anySpeeding = events.find((event) => {
    const normalized = normalizeEventType(event);
    return normalized.includes('speed') || normalized.includes('speeding');
  });

  return anySpeeding || null;
}

/**
 * Format example event for display.
 */
function formatExampleEvent(event: SafetyEvent): string {
  const lines: string[] = [];

  lines.push(`*ID:* \`${event.id}\``);
  
  const normalized = normalizeEventType(event);
  lines.push(`*Normalized Type:* ${normalized || 'N/A'}`);
  
  const severity = event.severity || 'N/A';
  lines.push(`*Severity:* ${severity}`);
  
  const eventTime = getEventTime(event);
  lines.push(`*Time:* ${eventTime ? new Date(eventTime).toISOString() : 'N/A'}`);
  
  const driverId = event.driverId || 'N/A';
  lines.push(`*Driver ID:* ${driverId}`);
  
  const videoUrl = getVideoUrl(event);
  lines.push(`*Video URL:* ${videoUrl ? 'Yes (exists)' : 'No'}`);
  
  if (videoUrl) {
    // Mask URL for security
    try {
      const url = new URL(videoUrl);
      const masked = `${url.protocol}//${url.hostname}${url.pathname}...`;
      lines.push(`  \`${masked}\``);
    } catch {
      lines.push(`  \`${videoUrl.substring(0, 50)}...\``);
    }
  }

  // Add behavior labels if present
  if (event.behaviorLabels && event.behaviorLabels.length > 0) {
    const labels = event.behaviorLabels
      .map((l) => `${l.name || l.label || 'unknown'}`)
      .join(', ');
    lines.push(`*Behavior Labels:* ${labels}`);
  }

  return lines.join('\n');
}

/**
 * Get top event types from unified events.
 */
function getTopUnifiedEventTypes(
  events: UnifiedEvent[],
  topN: number = 5
): Array<{ type: string; count: number }> {
  const typeCounts = new Map<string, number>();

  for (const event of events) {
    const type = event.type || 'unknown';
    const current = typeCounts.get(type) || 0;
    typeCounts.set(type, current + 1);
  }

  return Array.from(typeCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Format example severe speeding interval for display (plain text, no Markdown).
 */
function formatExampleSpeedingInterval(interval: SpeedingInterval): string {
  const lines: string[] = [];

  lines.push(`ID: speeding:${interval.assetId}:${interval.startTime}:${interval.endTime}`);
  lines.push(`Asset ID: ${interval.assetId}`);
  lines.push(`Start Time: ${new Date(interval.startTime).toISOString()}`);
  lines.push(`End Time: ${new Date(interval.endTime).toISOString()}`);
  lines.push(`Severity: ${interval.severityLevel?.toUpperCase() || 'SEVERE'}`); // Show SEVERE, not N/A
  lines.push(
    `Max Speed: ${interval.maxSpeedMph != null ? `${interval.maxSpeedMph} mph` : 'N/A'}`
  );
  lines.push(
    `Speed Limit: ${interval.speedLimitMph != null ? `${interval.speedLimitMph} mph` : 'N/A'}`
  );
  lines.push(`Driver ID: ${interval.driverId || 'N/A'}`);
  lines.push(`Video URL: N/A (speeding intervals typically don't include video)`);

  return lines.join('\n');
}

/**
 * Debug safety command handler.
 * 
 * Usage: /debug_safety [hours]
 * - Default: 10 hours
 * - Min: 1 hour, Max: 48 hours
 */
export async function handleDebugSafety(ctx: Context): Promise<void> {
  // Parse hours argument
  const args =
    ctx.message && 'text' in ctx.message
      ? ctx.message.text.split(/\s+/).slice(1)
      : [];

  let hours = 10; // Default
  if (args.length > 0) {
    const parsed = parseFloat(args[0]);
    if (!isNaN(parsed)) {
      hours = Math.max(1, Math.min(48, Math.round(parsed))); // Clamp between 1 and 48
    }
  }

  await ctx.reply(`🔍 Fetching events for last ${hours} hours...`);

  // Calculate time window for safety events
  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

  // Get vehicle count and mode
  const vehicleAssetIds = await getAllVehicleAssetIds();
  const mode = 'auto-fetched';

  // Get speeding window configuration
  const windowHours = parseInt(process.env.SPEEDING_WINDOW_HOURS || '6', 10);
  const bufferMinutes = parseInt(process.env.SPEEDING_BUFFER_MINUTES || '10', 10);
  const speedingWindowHours = Math.max(hours, windowHours);

  // Fetch both safety events and speeding intervals (DO NOT write to DB, DO NOT send to groups)
  // Safety: uses explicit window (last N hours)
  // Speeding: uses sliding window strategy (max(N, windowHours) + buffer)
  const [safetyEvents, speedingResult] = await Promise.all([
    getSafetyEventsInWindow({ from, to: now }, 200),
    fetchSpeedingIntervalsWithSlidingWindow(),
  ]);

  const speedingIntervals = speedingResult.newToPost; // Use newToPost to see what would be posted
  const totalSpeedingIntervals = speedingResult.total;
  const severeSpeedingTotal = speedingResult.severe; // Total severe (including already sent)

  // Log diagnostic info
  console.log(
    `[DEBUG_SAFETY] Fetched ${safetyEvents.length} safety events and ${totalSpeedingIntervals} speeding intervals (${severeSpeedingTotal} severe total, ${speedingIntervals.length} new to post) for ${hours} hours`
  );

  // Normalize both
  const normalizedSafety = normalizeSafetyEvents(safetyEvents);
  const normalizedSpeeding = normalizeSpeedingIntervals(speedingIntervals);

  // Merge and dedupe
  const allUnifiedEvents = mergeAndDedupeEvents([
    ...normalizedSafety,
    ...normalizedSpeeding,
  ]);

  // Analyze
  const totalSafetyEvents = safetyEvents.length;
  const severeSpeedingNewCount = speedingIntervals.length;
  const topTypes = getTopUnifiedEventTypes(allUnifiedEvents, 5);
  const exampleSevereSpeeding =
    speedingIntervals.length > 0 ? speedingIntervals[0] : null;

  // Build response (plain text, no Markdown to avoid parsing errors)
  const responseLines: string[] = [];

  responseLines.push(`📊 Safety Events Diagnostics`);
  responseLines.push('');
  responseLines.push(`Windows:`);
  responseLines.push(`  Safety window: last ${hours} hours (${from.toISOString()} to ${now.toISOString()})`);
  responseLines.push(`  Speeding window: ${speedingWindowHours}h + ${bufferMinutes}m buffer (${speedingResult.windowStart} to ${speedingResult.windowEnd})`);
  responseLines.push('');
  responseLines.push(`Vehicles count: ${vehicleAssetIds.length} (mode: ${mode})`);
  responseLines.push(`Safety Events (raw): ${totalSafetyEvents}`);
  responseLines.push(`Safety Events (normalized): ${normalizedSafety.length}`);
  responseLines.push(`Speeding intervals (total): ${totalSpeedingIntervals}`);
  responseLines.push(`Speeding intervals (severe total): ${severeSpeedingTotal}`);
  responseLines.push(`Speeding intervals (new to post): ${severeSpeedingNewCount}`);
  responseLines.push('');

  if (topTypes.length > 0) {
    responseLines.push(`Top Event Types (merged):`);
    for (const { type, count } of topTypes) {
      responseLines.push(`  - ${type}: ${count}`);
    }
    responseLines.push('');
  }

  if (exampleSevereSpeeding) {
    responseLines.push(`Example Severe Speeding Interval:`);
    responseLines.push(formatExampleSpeedingInterval(exampleSevereSpeeding));
  } else {
    responseLines.push(`Example Severe Speeding Interval: None found`);
  }

  const response = responseLines.join('\n');

  // Reply ONLY in private chat (already guarded by middleware)
  // Use plain text to avoid Markdown parsing errors
  await ctx.reply(response, { parse_mode: undefined });
}

