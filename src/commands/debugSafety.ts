import { Context } from 'telegraf';
import { getSafetyEventsInWindow, SafetyEvent } from '../samsara';

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
 * Debug safety command handler.
 * 
 * Usage: /debug_safety [hours]
 * - Default: 10 hours
 * - Min: 1 hour, Max: 48 hours
 */
export async function handleDebugSafety(ctx: Context): Promise<void> {
  // Parse hours argument
  const args = ctx.message && 'text' in ctx.message 
    ? ctx.message.text.split(/\s+/).slice(1) 
    : [];
  
  let hours = 10; // Default
  if (args.length > 0) {
    const parsed = parseFloat(args[0]);
    if (!isNaN(parsed)) {
      hours = Math.max(1, Math.min(48, Math.round(parsed))); // Clamp between 1 and 48
    }
  }

  await ctx.reply(`🔍 Fetching safety events for last ${hours} hours...`);

  // Calculate time window
  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

  // Fetch events (DO NOT write to DB, DO NOT send to groups)
  const events = await getSafetyEventsInWindow({ from, to: now }, 200);

  // Log diagnostic info (temporary console logs)
  console.log(`[DEBUG_SAFETY] Fetched ${events.length} events for ${hours} hours`);
  for (const event of events.slice(0, 5)) {
    // Log raw event type fields and severity
    console.log(`[DEBUG_SAFETY] Event ${event.id}:`, {
      type: event.type,
      eventType: event.eventType,
      behaviorType: event.behaviorType,
      severity: event.severity,
      labels: event.behaviorLabels?.map((l) => ({ label: l.label, name: l.name })),
      normalized: normalizeEventType(event),
    });
  }

  // Analyze events
  const totalEvents = events.length;
  const topTypes = getTopEventTypes(events, 5);
  const severeSpeedingEvents = events.filter(isSevereSpeeding);
  const hasSevereSpeeding = severeSpeedingEvents.length > 0;
  const exampleEvent = findExampleSevereSpeedingEvent(events) || events[0] || null;

  // Build response
  const responseLines: string[] = [];

  responseLines.push(`📊 *Safety Events Diagnostics*`);
  responseLines.push(`*Time Window:* Last ${hours} hours`);
  responseLines.push(`*Total Events:* ${totalEvents}`);
  responseLines.push('');

  if (topTypes.length > 0) {
    responseLines.push(`*Top Event Types:*`);
    for (const { type, count } of topTypes) {
      responseLines.push(`  • ${type}: ${count}`);
    }
    responseLines.push('');
  }

  responseLines.push(`*Severe Speeding Detection:*`);
  if (hasSevereSpeeding) {
    responseLines.push(`  ✅ Found ${severeSpeedingEvents.length} Severe Speeding event(s)`);
    responseLines.push(`  (Checked: type, eventType, behaviorType, label, name, severity)`);
  } else {
    responseLines.push(`  ❌ No Severe Speeding events found`);
    responseLines.push(`  (Checked: type, eventType, behaviorType, label, name, severity)`);
  }
  responseLines.push('');

  if (exampleEvent) {
    responseLines.push(`*Example Event:*`);
    responseLines.push(formatExampleEvent(exampleEvent));
  } else {
    responseLines.push(`*Example Event:* No events found`);
  }

  const response = responseLines.join('\n');

  // Reply ONLY in private chat (already guarded by middleware)
  await ctx.reply(response, { parse_mode: 'Markdown' });
}

