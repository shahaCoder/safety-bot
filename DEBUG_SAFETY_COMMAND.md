# Debug Safety Command Documentation

## Overview

The `/debug_safety` command allows admins to safely inspect Samsara safety events (especially Severe Speeding) in private chats only, without affecting production cron behavior or sending messages to group chats.

## Security

- **Private chat only**: Command only works in private chats (`ctx.chat.type === 'private'`)
- **Admin only**: Only users listed in `TELEGRAM_ADMIN_IDS` can use the command
- **No group messages**: Absolutely no messages sent to groups, channels, or stored chats
- **Read-only**: Does not write to database or trigger any production actions

## Setup

### Environment Variable

Add to `.env`:
```env
TELEGRAM_ADMIN_IDS=123456789,987654321
```

Where the numbers are comma-separated Telegram user IDs of admins.

### Finding Your Telegram User ID

1. Send `/id` command to the bot in a group (if it responds)
2. Or use `@userinfobot` on Telegram
3. Or check the bot logs when you send a message

## Usage

### Basic Usage

```
/debug_safety
```

Defaults to 10 hours lookback.

### Custom Time Window

```
/debug_safety 12
```

- **Default**: 10 hours
- **Minimum**: 1 hour
- **Maximum**: 48 hours
- Hours are automatically clamped to valid range

## Command Output

The command provides:

1. **Total Events**: Count of all safety events in the time window
2. **Top Event Types**: Top 5 event types by frequency (normalized)
3. **Severe Speeding Detection**: 
   - Whether Severe Speeding events were found
   - Checks multiple fields: `type`, `eventType`, `behaviorType`, `label`, `name`, `severity`
4. **Example Event**: Shows one example event with key fields:
   - Event ID
   - Normalized type
   - Severity
   - Time (occurredAt/startTime/time)
   - Driver ID
   - Video URL (if exists, masked for security)
   - Behavior labels

## Example Response

```
📊 Safety Events Diagnostics
Time Window: Last 12 hours
Total Events: 45

Top Event Types:
  • severe speeding: 12
  • harsh brake: 8
  • following distance: 15
  • yield: 5
  • red light: 5

Severe Speeding Detection:
  ✅ Found 12 Severe Speeding event(s)
  (Checked: type, eventType, behaviorType, label, name, severity)

Example Event:
ID: `abc123def456`
Normalized Type: severe speeding
Severity: severe
Time: 2024-01-15T14:30:00.000Z
Driver ID: driver-789
Video URL: Yes (exists)
  `https://s3.amazonaws.com/bucket/path/video.mp4...`
Behavior Labels: Severe Speeding, Speeding
```

## Implementation Details

### Files Created

1. **`src/guards/isAdmin.ts`**
   - `isAdminInPrivateChat()`: Checks if user is admin in private chat
   - `requireAdminPrivateChat()`: Middleware guard for commands

2. **`src/commands/debugSafety.ts`**
   - `handleDebugSafety()`: Main command handler
   - `normalizeEventType()`: Normalizes event types from multiple fields
   - `isSevereSpeeding()`: Detects Severe Speeding events
   - `getTopEventTypes()`: Analyzes event frequency
   - `findExampleSevereSpeedingEvent()`: Finds example event

3. **`src/samsara.ts`** (extended)
   - `getSafetyEventsInWindow()`: New function for custom time windows
   - Extended `SafetyEvent` interface with additional fields

### Severe Speeding Detection

The command checks for "Severe Speeding" in multiple ways:

1. **Normalized type fields**: `type`, `eventType`, `behaviorType`
2. **Behavior labels**: `label`, `name` fields in `behaviorLabels[]`
3. **Severity field**: `severity` field combined with "speed" in type
4. **Variations**: Handles "severe speed", "severe speeding", "severespeeding", "severe_speed"

This is necessary because Samsara UI label "Severe Speeding" may not equal the API field value.

### Logging

The command logs diagnostic information to console (not secrets/tokens):

```
[DEBUG_SAFETY] Fetched 45 events for 12 hours
[DEBUG_SAFETY] Event abc123: {
  type: 'severeSpeeding',
  eventType: 'severe_speeding',
  behaviorType: null,
  severity: 'severe',
  labels: [{ label: 'severespeed', name: 'Severe Speeding' }],
  normalized: 'severespeeding severe speeding'
}
```

## Safety Guarantees

1. **No Database Writes**: Command does not call `logSafetyEvent()` or any DB write operations
2. **No Group Messages**: Command only replies in private chat (guarded)
3. **No Production Impact**: Does not affect cron job behavior
4. **Admin Only**: Guard ensures only authorized admins can use it
5. **Private Chat Only**: Guard ensures command only works in private chats

## Testing

### Local Testing

1. Add your Telegram user ID to `TELEGRAM_ADMIN_IDS` in `.env`
2. Start bot: `npm run dev`
3. Send `/debug_safety` in private chat with bot
4. Verify response format and data

### Production Testing

1. Ensure `TELEGRAM_ADMIN_IDS` is set in production `.env`
2. Restart bot: `pm2 restart pti-bot`
3. Send `/debug_safety` in private chat
4. Verify no messages appear in any group chats
5. Check logs for diagnostic output

## Troubleshooting

### "Forbidden" Response

- Check `TELEGRAM_ADMIN_IDS` is set in `.env`
- Verify your user ID is in the comma-separated list
- Ensure you're messaging the bot in a **private chat** (not group)

### No Events Found

- Check time window (default 10 hours, max 48 hours)
- Verify Samsara API token is valid
- Check bot logs for Samsara API errors

### Severe Speeding Not Detected

- Check console logs for raw event fields
- Verify Samsara API response structure
- Event may use different field names than expected
- Command checks multiple fields, but Samsara API may vary

## Code Structure

```
src/
├── guards/
│   └── isAdmin.ts          # Admin + private chat guard
├── commands/
│   └── debugSafety.ts      # Debug command handler
├── samsara.ts              # Extended with getSafetyEventsInWindow()
└── index.ts                # Command registration (before private chat filter)
```

Command is registered **before** the private chat filter to ensure it can handle private chats.

