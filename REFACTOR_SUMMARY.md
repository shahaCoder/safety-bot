# Safety Alert Video Refactor - Summary

## Problem Fixed

**Bug**: When cron/auto sends safety warning messages, Telegram posts were sent without video attachments, even when video URLs were available from Samsara events.

**Root Cause**: The cron path (`checkAndNotifySafetyEvents`) and the `/safety_test` command used different code paths with subtle differences in video handling.

## Solution

Created a shared helper function `sendSafetyAlertWithVideo()` that ensures both `/safety_test` and cron use **identical behavior** for:
- Video URL selection (forward > inward > generic)
- Video sending method
- Error handling and fallback strategy
- Logging format

## Key Changes

### 1. Shared Helper Function (`sendSafetyAlertWithVideo`)

**Location**: `src/index.ts` (lines ~470-620)

**Features**:
- **Same video selection logic** as `buildSafetyPayload()`: `forward || inward || generic`
- **Primary method**: `bot.telegram.sendVideo(chatId, videoUrl, ...)` - same as `/safety_test` uses `ctx.replyWithVideo()`
- **Robust fallback strategy**:
  1. First attempt: Send video via URL (same as `/safety_test`)
  2. If URL send fails with common Telegram fetch errors (400, 403, etc.):
     - Download video to `/tmp` (with timeout 30s, max size 25MB)
     - Send as file stream: `bot.telegram.sendVideo(chatId, { source: fs.createReadStream(...) }, ...)`
     - Clean up temp file
  3. If all video methods fail: Send text message only, log error (not in chat)
- **Comprehensive logging**:
  - Event ID, truck name/ID, chatId
  - Masked video URL (hides query params)
  - URL hostname
  - Telegram error responses
  - Video failure reasons (logged, not shown in chat)

### 2. Refactored `/safety_test` Command

**Location**: `src/index.ts` (lines ~650-680)

**Changes**:
- Now uses `sendSafetyAlertWithVideo()` helper
- Ensures identical behavior to cron path
- No driver mentions (as before)

### 3. Refactored Cron Path (`checkAndNotifySafetyEvents`)

**Location**: `src/index.ts` (lines ~430-520)

**Changes**:
- Now uses `sendSafetyAlertWithVideo()` helper
- Maintains driver mention logic (unchanged)
- Same video handling as `/safety_test`

### 4. Dry Run Mode

**Environment Variable**: `DRY_RUN_MODE=true`

**Behavior**:
- When enabled, simulates sending without actually sending to Telegram
- Logs what would be sent (caption preview, video URL)
- Useful for testing cron processing without spamming Telegram

### 5. Configuration

**New Environment Variables**:
- `DRY_RUN_MODE` (default: `false`) - Enable dry run mode
- `VIDEO_DOWNLOAD_MAX_SIZE_MB` (default: `25`) - Max video size for fallback download
- `VIDEO_DOWNLOAD_TIMEOUT_MS` (default: `30000`) - Timeout for video download

### 6. Test Script

**Location**: `src/test-safety-helper.ts`

**Usage**:
```bash
# Dry run (no actual sending)
DRY_RUN_MODE=true TELEGRAM_BOT_TOKEN=xxx npm run test:safety-helper

# Real test (sends to Telegram)
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx npm run test:safety-helper

# With custom event JSON file
DRY_RUN_MODE=true TELEGRAM_BOT_TOKEN=xxx npm run test:safety-helper sample-event.json
```

## Code Differences Explained (Comments in Code)

### Video URL Selection
```typescript
// Same for both paths:
const forward = event.downloadForwardVideoUrl;
const inward = (event as any).downloadInwardVideoUrl;
const generic = (event as any).downloadVideoUrl;
const videoUrl = forward || inward || generic; // Priority: forward > inward > generic
```

### Sending Method
```typescript
// /safety_test (before): ctx.replyWithVideo(videoUrl, ...)
// Cron (before): bot.telegram.sendVideo(chatId, videoUrl, ...)
// Both (now): sendSafetyAlertWithVideo() -> bot.telegram.sendVideo(chatId, videoUrl, ...)
// Same underlying Telegram API method
```

### Error Handling
```typescript
// Both paths now use same try-catch with fallback:
// 1. Try sendVideo with URL
// 2. If fails, download and send as stream
// 3. If that fails, send text only (log error, don't show in chat)
```

### Chat ID
```typescript
// /safety_test: Uses ctx.chat.id (from command context)
// Cron: Uses chat.telegramChatId (from database lookup)
// Both passed to same helper function
```

## How to Verify

### 1. Local Testing

```bash
# Build the project
npm run build

# Test the helper function (dry run)
DRY_RUN_MODE=true TELEGRAM_BOT_TOKEN=xxx npm run test:safety-helper

# Test /safety_test command in Telegram
# Send: /safety_test
# Expected: Should show events with videos (if available)

# Test cron in dry run mode
DRY_RUN_MODE=true npm run dev
# Wait for cron tick (every minute)
# Check logs for [DRY RUN] messages
```

### 2. Server Testing (PM2)

```bash
# Build on server
npm run build

# Set environment variables in .env or PM2 ecosystem
# DRY_RUN_MODE=false (or omit for production)
# VIDEO_DOWNLOAD_MAX_SIZE_MB=25
# VIDEO_DOWNLOAD_TIMEOUT_MS=30000

# Restart PM2
pm2 restart pti-bot

# Monitor logs
pm2 logs pti-bot

# Expected logs when event is processed:
# 📤 [sendSafetyAlertWithVideo] Event <id> | Truck: <name> | ChatId: <id> | Video: <masked-url> | Host: <hostname>
# ✅ [sendSafetyAlertWithVideo] Event <id> sent with video (URL) to chatId <id>
```

### 3. Verification Checklist

- [ ] **Video appears in Telegram chat** when cron sends safety alert
- [ ] **Video selection works** (forward video preferred over inward/generic)
- [ ] **Fallback works** if URL send fails (downloads and sends as stream)
- [ ] **Text-only fallback** works if all video methods fail (error logged, not in chat)
- [ ] **Logs are comprehensive** (event ID, truck name, chatId, masked URL, hostname)
- [ ] **Dry run mode works** (no actual sending when `DRY_RUN_MODE=true`)
- [ ] **`/safety_test` still works** and shows videos
- [ ] **Driver mentions still work** in cron path (unchanged)
- [ ] **No duplicate events** (database deduplication still works)

### 4. Expected Log Output

**Successful video send (URL method)**:
```
📤 [sendSafetyAlertWithVideo] Event abc123 | Truck: Truck 105 (veh-456) | ChatId: -1001234567890 | Video: https://s3.amazonaws.com/... | Host: s3.amazonaws.com
✅ [sendSafetyAlertWithVideo] Event abc123 sent with video (URL) to chatId -1001234567890
✅ Sent safety event abc123 for Truck 105 to Group Name (chatId=-1001234567890)
```

**Fallback to file stream**:
```
📤 [sendSafetyAlertWithVideo] Event abc123 | Truck: Truck 105 (veh-456) | ChatId: -1001234567890 | Video: https://s3.amazonaws.com/... | Host: s3.amazonaws.com
⚠️ [sendSafetyAlertWithVideo] Event abc123 failed to send video via URL (code: 400): Bad Request
   Attempting fallback: download and send as file stream...
✅ [sendSafetyAlertWithVideo] Event abc123 sent with video (file stream fallback) to chatId -1001234567890
```

**Text-only fallback**:
```
📤 [sendSafetyAlertWithVideo] Event abc123 | Truck: Truck 105 (veh-456) | ChatId: -1001234567890 | Video: https://s3.amazonaws.com/... | Host: s3.amazonaws.com
⚠️ [sendSafetyAlertWithVideo] Event abc123 failed to send video via URL (code: 400): Bad Request
   Attempting fallback: download and send as file stream...
❌ Failed to download video for event abc123: timeout
   Download failed, sending text only...
✅ [sendSafetyAlertWithVideo] Event abc123 sent (text only, video download failed) to chatId -1001234567890
   (video failed: download error)
✅ Sent safety event abc123 for Truck 105 to Group Name (chatId=-1001234567890) (video failed, text sent)
```

**Dry run mode**:
```
📤 [sendSafetyAlertWithVideo] Event abc123 | Truck: Truck 105 (veh-456) | ChatId: -1001234567890 | Video: https://s3.amazonaws.com/... | Host: s3.amazonaws.com [DRY RUN]
🔍 [DRY RUN] Would send to chatId -1001234567890:
   Caption: ⚠️ *Safety Warning*
*Truck:* Truck 105
*Behavior:* Speeding
*Time:* ...
   Video URL: https://s3.amazonaws.com/...
```

## Commit Message Suggestion

```
fix: Ensure cron safety alerts include videos like /safety_test

- Extract shared sendSafetyAlertWithVideo() helper function
- Refactor both /safety_test and cron to use same helper
- Implement robust fallback: URL -> download -> text-only
- Add comprehensive logging (event ID, truck, chatId, masked URL, errors)
- Add dry run mode via DRY_RUN_MODE env var
- Add test script for helper function
- Configure video download limits (25MB max, 30s timeout)

Both code paths now use identical video selection logic (forward > inward > generic)
and sending method (sendVideo with URL, fallback to file stream if needed).

Fixes issue where cron safety alerts were sent without video attachments.
```

## Files Modified

1. `src/index.ts` - Main bot file with shared helper and refactored paths
2. `src/test-safety-helper.ts` - New test script for helper function
3. `package.json` - Added `test:safety-helper` script

## Environment Variables

Add to `.env` (optional, defaults shown):
```env
DRY_RUN_MODE=false
VIDEO_DOWNLOAD_MAX_SIZE_MB=25
VIDEO_DOWNLOAD_TIMEOUT_MS=30000
```

