# Severe Speeding Production Implementation

## Overview

Full production implementation of Severe Speeding alerts from Samsara Speeding Intervals API. The system now automatically fetches all vehicles, processes severe speeding intervals, and sends alerts to Telegram groups with proper deduplication.

## Key Features

1. **Automatic Vehicle Discovery**: Fetches all vehicles from Samsara API (no manual SAMSARA_ASSET_IDS required)
2. **Chunking Support**: Handles large fleets by chunking requests (200 vehicles per chunk)
3. **Deduplication**: Prevents duplicate alerts using database (SentEvent table)
4. **Plain Text Messages**: No Markdown parsing issues
5. **Vehicle Name Mapping**: Maps assetId to vehicle name for better readability

## Implementation Details

### A) Auto-get All Vehicles with Caching

**File**: `src/services/samsaraVehicles.ts`

- **Endpoint**: `GET https://api.samsara.com/fleet/vehicles`
- **Caching**: 10 minute TTL, in-memory cache
- **Env Override**: If `SAMSARA_ASSET_IDS` is set, uses it instead of fetching
- **Logs**:
  - `[SAMSARA] vehicles fetched: N`
  - `[SAMSARA] vehicles cache hit: N`
  - `[SAMSARA] vehicles cache miss, fetching from API...`

**Functions**:
- `getAllVehicleAssetIds()`: Returns array of vehicle IDs
- `getVehicleNameById(assetId)`: Maps assetId to vehicle name
- `getAllVehiclesInfo()`: Returns full vehicle info array

### B) Fetch Speeding Intervals for ALL Vehicles (with Chunking)

**File**: `src/services/samsaraSpeeding.ts`

**Chunking**:
- Chunk size: 200 vehicles (configurable)
- Uses `URLSearchParams` with repeated `assetIds` keys
- Each chunk processed separately with error handling

**Query Params**:
```typescript
params.append('assetIds', id) // for each id
params.set('startTime', from.toISOString())
params.set('endTime', to.toISOString())
```

**Response Parsing**:
```typescript
records = payload.data ?? []
flatIntervals = records.flatMap(r => 
  (r.intervals ?? []).map(i => ({...i, assetId: r.asset.id}))
)
```

**Severe Detection**:
```typescript
severeIntervals = flatIntervals.filter(i => 
  i.severityLevel?.toLowerCase() === 'severe'
)
```

**Logs**:
- `[SAMSARA] speeding chunk i/j: records=X intervals=Y severe=Z`
- `[SAMSARA] Total: X intervals (all), Y severe, across Z chunk(s)`

### C) Deduplication (Database)

**Prisma Model**: `SentEvent`
```prisma
model SentEvent {
  id        String   @id // Stable event ID
  type      String   // Event type (e.g., "severe_speeding")
  sentAt    DateTime @default(now())
}
```

**Migration**: `20251212162821_add_sent_event`

**Functions** (`src/repository.ts`):
- `isEventSent(eventId)`: Check if event was already sent
- `markEventSent(eventId, eventType)`: Mark event as sent

**Usage**:
```typescript
// Before sending
if (await isEventSent(event.id)) {
  continue; // Skip
}

// After sending
await markEventSent(event.id, event.type);
```

### D) Send Severe Speeding Alerts

**Message Format** (plain text, no Markdown):
```
🚨 SEVERE SPEEDING
Truck: Truck 704
80.1 mph in 55.3 mph (+24.8)
Duration: 1m 21s
Time: Dec 12, 2:10 AM ET
Location: I 80, Shenango Township, PA
```

**Function**: `formatSevereSpeedingMessage(event, vehicleName)`

**Features**:
- Calculates delta mph (over speed limit)
- Formats duration (mm:ss)
- Formats time (America/New_York timezone)
- Includes location if available
- Plain text (no Markdown parsing)

**Vehicle Name Resolution**:
1. Try `event.vehicleName` (from safety events)
2. Try `getVehicleNameById(event.assetId)` (from vehicles cache)
3. Fallback to `event.assetId`

### E) Integration into Cron Pipeline

**File**: `src/index.ts` - `checkAndNotifySafetyEvents()`

**Flow**:
1. Fetch safety events (existing)
2. Fetch speeding intervals (new, all vehicles)
3. Normalize both into `UnifiedEvent[]`
4. Merge and deduplicate
5. Filter for relevant events (includes `severe_speeding`)
6. For each event:
   - Check dedup (`isEventSent`)
   - Find chat by vehicle name
   - Send message (plain text for severe speeding, Markdown for safety)
   - Mark as sent (`markEventSent`)
   - Log to database

**Whitelist**: `severe_speeding` is always included in relevant events

### F) Improved /debug_safety

**New Output**:
```
📊 Safety Events Diagnostics
Time Window: Last 12 hours

Vehicles count: 15 (mode: auto-fetched)
Safety Events (raw): 45
Safety Events (normalized): 45
Speeding intervals (total): 120
Severe speeding count: 8

Top Event Types (merged):
  - severe_speeding: 8
  - harsh_brake: 5
  ...

Example Severe Speeding Interval:
ID: speeding:281474995523174:2025-12-12T05:00:00Z:2025-12-12T05:01:21Z
Asset ID: 281474995523174
Start Time: 2025-12-12T05:00:00.000Z
End Time: 2025-12-12T05:01:21.000Z
Severity: SEVERE
Max Speed: 80.1 mph
Speed Limit: 55.3 mph
Driver ID: driver-123
Video URL: N/A (speeding intervals typically don't include video)
```

**Changes**:
- Shows vehicles count and mode (env override vs auto-fetched)
- Shows total intervals (flattened)
- Shows severe count separately
- Severity shows "SEVERE" (not N/A)
- Plain text output (no Markdown)

### G) Safety / Rate Limits

**Error Handling**:
- Try/catch per chunk (one failing chunk doesn't kill the whole tick)
- Logs errors without secrets
- Continues processing other chunks on failure

**Logs** (no secrets):
- Request URL and params (assetIds shown, token hidden)
- Response status
- Counts per chunk
- Final summary

## Database Migration

**Migration**: `prisma/migrations/20251212162821_add_sent_event/migration.sql`

**To Apply**:
```bash
npx prisma migrate deploy
# or for dev
npx prisma migrate dev
```

## Environment Variables

**Optional** (for testing override):
```env
SAMSARA_ASSET_IDS=281474995523174,281474995523175
```

If set, uses these IDs instead of fetching all vehicles. Useful for testing.

**Required**:
```env
SAM_SARA_API_TOKEN=your_token_here
TELEGRAM_BOT_TOKEN=your_bot_token
DATABASE_URL=postgresql://...
```

## Files Created/Modified

### New Files
- `src/services/samsaraVehicles.ts` - Vehicle fetching and caching
- `prisma/migrations/20251212162821_add_sent_event/migration.sql` - SentEvent table

### Modified Files
- `src/services/samsaraSpeeding.ts` - Chunking and auto-fetch vehicles
- `src/services/eventNormalize.ts` - Include location.address in details
- `src/repository.ts` - Added `isEventSent()` and `markEventSent()`
- `src/index.ts` - Integrated severe speeding into cron, added message formatting
- `src/commands/debugSafety.ts` - Improved output with vehicles count and mode
- `prisma/schema.prisma` - Added SentEvent model

## Testing

### Local Testing

1. **Apply Migration**:
   ```bash
   npx prisma migrate dev
   ```

2. **Set Environment** (optional):
   ```env
   SAMSARA_ASSET_IDS=281474995523174  # For testing with specific vehicle
   ```

3. **Run Bot**:
   ```bash
   npm run dev
   ```

4. **Test Debug Command**:
   - Send `/debug_safety 12` in private chat
   - Verify output shows vehicles count, intervals, and severe count

5. **Monitor Logs**:
   - Check for `[SAMSARA] vehicles fetched: N`
   - Check for `[SAMSARA] speeding chunk i/j: ...`
   - Check for dedup logs

### Production Testing

1. **Apply Migration**:
   ```bash
   npx prisma migrate deploy
   ```

2. **Restart PM2**:
   ```bash
   pm2 restart pti-bot
   ```

3. **Monitor Logs**:
   ```bash
   pm2 logs pti-bot
   ```

4. **Verify**:
   - Severe speeding alerts appear in Telegram groups
   - No duplicate alerts for same interval
   - Debug command shows correct counts

## Expected Behavior

### Cron Job (Every Minute)

1. Fetches all vehicles (or uses env override)
2. Fetches safety events (last 60 min)
3. Fetches speeding intervals (last 60 min, all vehicles, chunked)
4. Normalizes and merges events
5. Filters for relevant (includes severe_speeding)
6. For each event:
   - Checks dedup
   - Finds chat by vehicle name
   - Sends alert (plain text for severe speeding)
   - Marks as sent
   - Logs to database

### Message Format

**Severe Speeding** (plain text):
```
🚨 SEVERE SPEEDING
Truck: Truck 704
80.1 mph in 55.3 mph (+24.8)
Duration: 1m 21s
Time: Dec 12, 2:10 AM ET
Location: I 80, Shenango Township, PA
```

**Safety Events** (Markdown, with video if available):
```
⚠️ *Safety Warning*
*Truck:* Truck 105
*Behavior:* Harsh Brake
*Time:* 12/12/2025, 02:10:00 AM
```

## Safety Guarantees

1. **No Duplicates**: Database deduplication prevents resending
2. **No Spam**: Only processes events in time window (last 60 min)
3. **Error Resilient**: Chunk failures don't stop entire tick
4. **Backward Compatible**: Existing safety events pipeline unchanged
5. **Plain Text**: No Markdown parsing errors for severe speeding

## Performance

- **Vehicle Cache**: 10 minutes TTL (reduces API calls)
- **Chunking**: 200 vehicles per chunk (avoids URL limits)
- **Parallel Fetching**: Safety events and speeding intervals fetched in parallel
- **Database Indexes**: SentEvent table indexed on `id`, `type`, `sentAt`

## Troubleshooting

### No Vehicles Found

- Check `SAM_SARA_API_TOKEN` is valid
- Check token has `vehicles:read` permission
- Check logs for `[SAMSARA] vehicles fetched: N`

### No Severe Speeding Found

- Check time window (last 60 minutes)
- Check vehicle names match database (Truck table)
- Use `/debug_safety` to see counts
- Check logs for `[SAMSARA] speeding chunk ...`

### Duplicate Alerts

- Check `SentEvent` table exists
- Check `isEventSent()` is called before sending
- Check `markEventSent()` is called after sending
- Verify migration was applied

### Vehicle Name Not Found

- Check vehicles cache is populated
- Check `getVehicleNameById()` returns correct name
- Verify vehicle name matches Truck.name in database

## Next Steps (Optional)

1. **Chunking Optimization**: Adjust chunk size based on fleet size
2. **Vehicle Name Caching**: Cache vehicle name mapping separately
3. **Retry Logic**: Add retry for failed chunks
4. **Metrics**: Add metrics for severe speeding alerts sent

