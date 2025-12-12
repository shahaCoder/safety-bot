# Severe Speeding Implementation Summary

## Overview

Added support for Severe Speeding events from Samsara's Speeding Intervals API. The implementation merges speeding intervals with existing safety events into a unified pipeline while maintaining backward compatibility.

## Key Changes

### 1. New Services

**`src/services/samsaraSpeeding.ts`**
- `fetchSpeedingIntervals()`: Fetches severe speeding intervals from `/speeding-intervals/stream`
- Handles pagination automatically
- Filters for `severity === 'SEVERE'` (case-insensitive)
- Uses asset IDs from `SAMSARA_ASSET_IDS` env var or caches them

**`src/services/eventNormalize.ts`**
- `UnifiedEvent` type: Common format for both safety events and speeding intervals
- `normalizeSafetyEvent()`: Converts SafetyEvent to UnifiedEvent
- `normalizeSpeedingInterval()`: Converts SpeedingInterval to UnifiedEvent
- `mergeAndDedupeEvents()`: Merges and deduplicates events by stable ID

### 2. Updated Repository

**`src/repository.ts`**
- `isEventProcessed()`: Now accepts any unified event ID (works for both safety and speeding)
- `logUnifiedEvent()`: New function to log unified events (both types)

### 3. Updated Cron Pipeline

**`src/index.ts`**
- `checkAndNotifySafetyEvents()`: Now fetches both safety events and speeding intervals
- Merges both types into unified events
- Filters for relevant events (includes `severe_speeding`)
- Processes all events through the same pipeline
- Logs counts per source: `[SAMSARA] safety events: X` and `[SAMSARA] speeding intervals: Y (severe: Z)`

### 4. Updated Debug Command

**`src/commands/debugSafety.ts`**
- Shows totals separately: safety events (raw + normalized) and speeding intervals
- Shows severe speeding count
- Shows example severe speeding interval with all key fields:
  - ID (stable key)
  - Asset ID
  - Start/End time
  - Severity
  - Max speed / Speed limit
  - Driver ID
  - Video URL status (N/A for speeding intervals)
- Shows top event types across merged events

## Configuration

### Required Environment Variable

Add to `.env`:

```env
SAMSARA_ASSET_IDS=asset-id-1,asset-id-2,asset-id-3
```

**Important**: The speeding intervals API requires asset IDs. The implementation:
1. First tries to use `SAMSARA_ASSET_IDS` from env (comma-separated)
2. Caches asset IDs in memory for 10 minutes
3. Logs which asset IDs were used if no events found

### Finding Asset IDs

Asset IDs can be found:
- In Samsara dashboard (vehicle/asset settings)
- From Samsara API `/fleet/vehicles` endpoint (if you have access)
- From existing safety events (check `vehicle.id` field)

## Event Deduplication

### Stable Event Keys

- **Safety events**: Use Samsara event ID directly (`event.id`)
- **Speeding intervals**: Use stable key format: `speeding:<assetId>:<startTime>:<endTime>`

### Database Storage

Both event types are stored in the same `SafetyEventLog` table using the `samsaraEventId` field (which now accepts any unified event ID).

## Logging

The implementation adds minimal logging (no secrets):

```
[SAMSARA] safety events: 15
[SAMSARA] speeding intervals: 8 (severe: 8)
📊 Total unified events after merge/dedup: 23 (safety: 15, speeding: 8)
```

If speeding returns 0 but events are expected, logs show which asset IDs were used:
```
[SAMSARA] No severe speeding intervals found. Asset IDs used: asset-1, asset-2
```

## Safety Guarantees

1. **No breaking changes**: Existing safety events pipeline unchanged
2. **No group spamming**: Same deduplication logic prevents resending
3. **Backward compatible**: Existing `logSafetyEvent()` still works
4. **Database compatible**: Uses existing `SafetyEventLog` table

## Testing

### Local Testing

1. Set `SAMSARA_ASSET_IDS` in `.env`
2. Build: `npm run build`
3. Test debug command: `/debug_safety 12` in private chat
4. Monitor logs for event counts

### Production Testing

1. Add `SAMSARA_ASSET_IDS` to production `.env`
2. Restart PM2: `pm2 restart pti-bot`
3. Monitor logs: `pm2 logs pti-bot`
4. Check for Severe Speeding events in cron output
5. Test `/debug_safety` command in DM

## Expected Behavior

### Cron Job

Every minute, the cron job:
1. Fetches safety events (last 60 minutes)
2. Fetches speeding intervals (last 60 minutes, severe only)
3. Normalizes both into unified events
4. Merges and deduplicates
5. Filters for relevant events (includes `severe_speeding`)
6. Sends to appropriate Telegram chats
7. Logs to database

### Debug Command

`/debug_safety [hours]` shows:
- Total safety events (raw + normalized)
- Total speeding intervals
- Severe speeding count
- Top event types (merged)
- Example severe speeding interval with all fields

## File Structure

```
src/
├── services/
│   ├── samsaraSpeeding.ts      # New: Speeding intervals API client
│   └── eventNormalize.ts        # New: Unified event normalization
├── commands/
│   └── debugSafety.ts          # Updated: Shows both event types
├── guards/
│   └── isAdmin.ts              # Existing: Admin guard
├── samsara.ts                  # Existing: Safety events API
├── repository.ts               # Updated: Unified event logging
└── index.ts                    # Updated: Merged cron pipeline
```

## Notes

- Speeding intervals typically don't include video URLs (shown as N/A in debug)
- Asset IDs are cached for 10 minutes to reduce API calls
- All severe speeding intervals are considered relevant (always sent)
- Deduplication prevents the same interval from being sent multiple times
- The implementation is minimal and doesn't change unrelated bot behavior

