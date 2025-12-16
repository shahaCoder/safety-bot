// dotenv MUST be the first import to ensure env vars are loaded before any other code reads process.env
import dotenv from 'dotenv';
dotenv.config({ path: '/opt/pti-bot/.env' });

console.log('[ENV] loaded', {
  cwd: process.cwd(),
  hasAssetIds: !!process.env.SAMSARA_ASSET_IDS,
});

import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { Chat } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

import { ptiMessages } from './messages';
import {
  getRecentSafetyEvents,
  getSafetyEventsInWindow,
  SafetyEvent,
  fetchSafetyEventMedia,
} from './samsara';
import {
  findChatByVehicleName,
  logSafetyEvent,
  logUnifiedEvent,
  isEventProcessed,
  isEventSent,
  markEventSent,
  getAllChats,
  findChatByTelegramChatId,
  updateChatMentionTemplate,
  setChatDriver,
  clearChatDriver,
  cleanupOldSentEvents,
  isPtiCompletedToday,
  markPtiCompleted,
  updateAllChatTruckNames,
} from './repository';
import { requireAdminPrivateChat } from './guards/isAdmin';
import { handleDebugSafety } from './commands/debugSafety';
import { fetchSpeedingIntervals, fetchSpeedingIntervalsWithSlidingWindow } from './services/samsaraSpeeding';
import { getAllVehicleAssetIds, getVehicleNameById } from './services/samsaraVehicles';
import {
  normalizeSafetyEvents,
  normalizeSpeedingIntervals,
  mergeAndDedupeEvents,
  UnifiedEvent,
} from './services/eventNormalize';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');
}

const bot = new Telegraf(BOT_TOKEN);

// Configuration for video download fallback
const VIDEO_DOWNLOAD_MAX_SIZE_MB = parseInt(
  process.env.VIDEO_DOWNLOAD_MAX_SIZE_MB || '25',
  10
);
const VIDEO_DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.VIDEO_DOWNLOAD_TIMEOUT_MS || '30000',
  10
);
const DRY_RUN_MODE = process.env.DRY_RUN_MODE === 'true';


// Языки для PTI-сообщений
type LanguageCode = 'en' | 'ru' | 'uz';

// ================== ГЛОБАЛЬНЫЕ ФИЛЬТРЫ ==================

async function isChatAdmin(ctx: any): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;

  const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
  return admins.some(
    (admin: any) =>
      admin.user.id === ctx.from.id &&
      (admin.status === 'administrator' || admin.status === 'creator'),
  );
}

// ================== ADMIN DEBUG COMMANDS (PRIVATE CHAT ONLY) ==================
// These must be registered BEFORE the private chat filter
// They use their own guard to ensure admin + private chat only

bot.command('debug_safety', requireAdminPrivateChat, handleDebugSafety);

// ================== /mark_pti_done (ADMIN) ==================
/**
 * Admin command to mark PTI as completed for the current chat.
 * Usage: /mark_pti_done
 * Only works in group chats (not private).
 */
bot.command('mark_pti_done', requireAdminPrivateChat, async (ctx) => {
  const chatId = ctx.chat?.id;
  
  if (!chatId || ctx.chat?.type === 'private') {
    await ctx.reply('❌ This command only works in group chats.');
    return;
  }

  try {
    const chat = await markPtiCompleted(BigInt(chatId));
    
    if (!chat) {
      await ctx.reply('❌ Chat not found in database. Please register the chat first.');
      return;
    }

    const lastPtiDate = chat.lastPtiDate 
      ? new Date(chat.lastPtiDate).toLocaleDateString('en-US', { 
          timeZone: 'America/New_York',
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        })
      : 'never';

    await ctx.reply(
      `✅ PTI marked as completed for ${chat.name}.\n` +
      `Last PTI date: ${lastPtiDate}\n` +
      `\n` +
      `This chat will NOT receive the 16:00 PTI reminder today.`
    );
  } catch (err: any) {
    console.error('❌ Error marking PTI completed:', err);
    await ctx.reply(`❌ Error: ${err.message || 'Unknown error'}`);
  }
});

// ================== /update_truck_names (ADMIN) ==================
/**
 * Admin command to update truckNames field for all chats.
 * Usage: /update_truck_names
 * Updates the truckNames field based on associated trucks (for Prisma Studio display).
 */
bot.command('update_truck_names', requireAdminPrivateChat, async (ctx) => {
  try {
    await updateAllChatTruckNames();
    await ctx.reply('✅ Updated truckNames for all chats. Check Prisma Studio to see the changes.');
  } catch (err: any) {
    console.error('❌ Error updating truckNames:', err);
    await ctx.reply(`❌ Error: ${err.message || 'Unknown error'}`);
  }
});

// Игнорировать все личные чаты (except admin debug commands above)
bot.use((ctx, next) => {
  if (ctx.chat?.type === 'private') {
    return; // молчим
  }
  return next();
});

// Игнорировать /start (если кто-то вдруг напишет в группу)
bot.start((ctx) => {
  // ничего не отвечаем
  console.log('[TG] from.id =', ctx.from?.id, 'chat.type =', ctx.chat?.type);
});

// ================== БАЗОВЫЕ КОМАНДЫ ==================

bot.command('ping', (ctx) => ctx.reply('pong 🏓'));

bot.command('id', (ctx) => {
  const chatId = ctx.chat?.id;
  ctx.reply(`Your chat id: \`${chatId}\``, { parse_mode: 'Markdown' });
});



// PTI сообщения вручную
bot.command('pti_en', (ctx) => ctx.reply(ptiMessages.en));
bot.command('pti_ru', (ctx) => ctx.reply(ptiMessages.ru));
bot.command('pti_uz', (ctx) => ctx.reply(ptiMessages.uz));

// ================== MENTION TEMPLATE COMMANDS ==================

bot.command('setmention', async (ctx) => {
  // Only work in groups/supergroups, ignore private chats
  if (ctx.chat?.type === 'private') {
    return; // Silently ignore
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  // Get the mention text from command arguments
  const mentionText = ctx.message.text
    .replace(/^\/setmention\s*/, '')
    .trim();

  if (!mentionText) {
    await ctx.reply(
      '❌ Please provide mention text. Example: /setmention @driver712'
    );
    return;
  }

  try {
    const telegramChatId = BigInt(chatId);
    const updatedChat = await updateChatMentionTemplate(
      telegramChatId,
      mentionText
    );

    if (!updatedChat) {
      await ctx.reply(
        '❌ Chat not found in database. Please ensure this chat is registered.'
      );
      return;
    }

    await ctx.reply('✅ Mention template saved for this chat.');
  } catch (err) {
    console.error('❌ Error setting mention template:', err);
    await ctx.reply('❌ Failed to save mention template.');
  }
});

bot.command('getmention', async (ctx) => {
  // Only work in groups/supergroups, ignore private chats
  if (ctx.chat?.type === 'private') {
    return; // Silently ignore
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  try {
    const telegramChatId = BigInt(chatId);
    const chat: Chat | null = await findChatByTelegramChatId(telegramChatId);

    if (!chat) {
      await ctx.reply('❌ Chat not found in database.');
      return;
    }

    // Access mentionTemplate - Prisma includes this field after schema update
    const chatWithMention = chat as Chat & { mentionTemplate?: string | null };
    const mentionTemplate = chatWithMention.mentionTemplate;
    if (mentionTemplate) {
      await ctx.reply(`Current mention template:\n${mentionTemplate}`);
    } else {
      await ctx.reply('No mention template set for this chat.');
    }
  } catch (err) {
    console.error('❌ Error getting mention template:', err);
    await ctx.reply('❌ Failed to get mention template.');
  }
});

// ================== DRIVER MANAGEMENT COMMANDS ==================

/**
 * Helper function to check if user is admin (optional - commented out by default)
 * To enable admin-only commands, uncomment and use this function
 */
async function isUserAdmin(
  chatId: number,
  userId: number
): Promise<boolean> {
  try {
    const admins = await bot.telegram.getChatAdministrators(chatId);
    return admins.some(
      (admin) =>
        admin.user.id === userId &&
        (admin.status === 'administrator' || admin.status === 'creator')
    );
  } catch (err) {
    console.error('❌ Error checking admin status:', err);
    return false; // On error, allow command (fail open)
  }
}

bot.command('setdriver', async (ctx) => {
  if (ctx.chat?.type === 'private') return;

  const isAdmin = await isChatAdmin(ctx);
  if (!isAdmin) {
    await ctx.reply('❌ Only group admins can use this command.');
    return;
  }

  const reply = ctx.message?.reply_to_message;
  if (!reply || !reply.from) {
    await ctx.reply('❌ Reply to the driver message and type /setdriver');
    return;
  }

  const user = reply.from;

  const result = await setChatDriver(BigInt(ctx.chat.id), {
    id: BigInt(user.id),
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username ?? null,
  });

  if (!result) {
    await ctx.reply('❌ This chat is not registered in the database.');
    return;
  }

  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const uname = user.username ? `@${user.username}` : '(no username)';

  await ctx.reply(`✅ Driver set for this group:\n${name} ${uname}`);
});


bot.command('getdriver', async (ctx) => {
  if (ctx.chat?.type === 'private') return;

  const isAdmin = await isChatAdmin(ctx);
  if (!isAdmin) {
    await ctx.reply('❌ Only group admins can use this command.');
    return;
  }

  const chat = await findChatByTelegramChatId(BigInt(ctx.chat.id));
  if (!chat) {
    await ctx.reply('❌ Chat not found in database.');
    return;
  }

  const chatWithDriver = chat as Chat & {
    driverTgUserId?: bigint | null;
    driverFirstName?: string | null;
    driverLastName?: string | null;
    driverUsername?: string | null;
  };

  if (!chatWithDriver.driverTgUserId) {
    await ctx.reply('No driver set for this group.');
    return;
  }

  const name = [chatWithDriver.driverFirstName, chatWithDriver.driverLastName]
    .filter(Boolean)
    .join(' ');
  const uname = chatWithDriver.driverUsername
    ? `@${chatWithDriver.driverUsername}`
    : `[Driver](tg://user?id=${chatWithDriver.driverTgUserId})`;

  await ctx.reply(`Current driver:\n${name}\n${uname}`, {
    parse_mode: 'Markdown',
  });
});


bot.command('cleardriver', async (ctx) => {
  if (ctx.chat?.type === 'private') return;

  const isAdmin = await isChatAdmin(ctx);
  if (!isAdmin) {
    await ctx.reply('❌ Only group admins can use this command.');
    return;
  }

  await clearChatDriver(BigInt(ctx.chat.id));
  await ctx.reply('✅ Driver cleared for this group.');
});


// ================== ФИЛЬТР SAFETY-СОБЫТИЙ ==================
//
// ТИПЫ, которые считаем серьёзными и хотим видеть в Телеграме.
//

// Подробные ключи для speeding
const SPEEDING_KEYWORDS = [
  'speed',
  'speeding',
  'max speed',
  'severe speed',
  'severe speeding',
  'speeding (manual)',
];

// Остальные серьёзные типы
const OTHER_SERIOUS_KEYWORDS = [
  'harsh brake', // Harsh Brake / Harsh Braking
  'harsh braking',
  'yield',       // Did Not Yield
  'red light',   // Ran Red Light
  'rolling stop' // Rolling Stop
];

const ALLOWED_KEYWORDS = [...SPEEDING_KEYWORDS, ...OTHER_SERIOUS_KEYWORDS];

const BLOCKED_KEYWORDS = ['following distance', 'followingdistance'];

function isRelevantEvent(ev: SafetyEvent): boolean {
  const labels = ev.behaviorLabels ?? [];
  if (!labels.length) return false;

  const text = labels
    .map((l) => `${l.label || ''} ${l.name || ''}`)
    .join(' ')
    .toLowerCase();

  const compact = text.replace(/[\s_]+/g, '');

  // выбрасываем Following Distance
  if (
    BLOCKED_KEYWORDS.some((kw) => {
      const kwCompact = kw.replace(/[\s_]+/g, '');
      return text.includes(kw) || compact.includes(kwCompact);
    })
  ) {
    return false;
  }

  // оставляем только серьёзные типы
  return ALLOWED_KEYWORDS.some((kw) => {
    const kwLower = kw.toLowerCase();
    const kwCompact = kwLower.replace(/[\s_]+/g, '');
    return text.includes(kwLower) || compact.includes(kwCompact);
  });
}

/**
 * Check if a unified event is relevant (should be sent to Telegram).
 * Includes severe_speeding from speeding intervals.
 */
function isRelevantUnifiedEvent(event: UnifiedEvent): boolean {
  // Severe speeding intervals are always relevant
  if (event.source === 'speeding' && event.type === 'severe_speeding') {
    return true;
  }

  // For safety events, use existing filter
  if (event.source === 'safety') {
    // Convert unified event back to SafetyEvent-like structure for filtering
    const type = event.type.toLowerCase();
    const compact = type.replace(/[\s_]+/g, '');

    // Block following distance
    if (
      BLOCKED_KEYWORDS.some((kw) => {
        const kwCompact = kw.replace(/[\s_]+/g, '');
        return type.includes(kw) || compact.includes(kwCompact);
      })
    ) {
      return false;
    }

    // Allow serious types
    return ALLOWED_KEYWORDS.some((kw) => {
      const kwLower = kw.toLowerCase();
      const kwCompact = kwLower.replace(/[\s_]+/g, '');
      return type.includes(kwLower) || compact.includes(kwCompact);
    });
  }

  return false;
}

// ================== ФОРМАТИРОВАНИЕ СООБЩЕНИЙ ==================

function formatLocalTime(dateIso: string): string {
  const d = new Date(dateIso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', // твой основной timezone
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSafetyCaption(ev: SafetyEvent): string {
  const vehicleName = ev.vehicle?.name ?? 'Unknown';
  const behavior =
    ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') ?? 'Unknown';
  const timeLocal = ev.time ? formatLocalTime(ev.time) : 'unknown time';

  const lat = ev.location?.latitude;
  const lon = ev.location?.longitude;
  const hasLocation = lat != null && lon != null;

  let caption = `⚠️ *Safety Warning*
*Truck:* ${vehicleName}
*Behavior:* ${behavior}
*Time:* ${timeLocal}`;

  if (hasLocation) {
    caption += `\n*Location:* ${lat.toFixed(5)}, ${lon.toFixed(5)}
https://www.google.com/maps?q=${lat},${lon}`;
  }

  return caption;
}

/**
 * Format severe speeding message (plain text, no Markdown).
 * 
 * Uses the final design template with proper formatting.
 * 
 * @param event - UnifiedEvent of type severe_speeding
 * @param vehicleName - Vehicle name (from mapping or assetId, e.g., "Truck 704")
 * @returns Plain text message formatted according to the design spec
 */
function formatSevereSpeedingMessage(
  event: UnifiedEvent,
  vehicleName: string
): string {
  // Extract truck number from vehicleName (e.g., "Truck 704" -> "704")
  const truckNumber = vehicleName.replace(/^Truck\s+/i, '').trim() || vehicleName;

  // Get speed data
  const speedLimitMph = Math.round(event.details?.speedLimitMph ?? 0);
  const actualSpeedMph = Math.round(event.details?.maxSpeedMph ?? 0);
  const overLimit = actualSpeedMph - speedLimitMph;

  // Format date: "Dec 13, 2025"
  const date = new Date(event.occurredAt);
  const dateLabel = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Format detected time: "10:15 AM"
  const detectedAt = new Date(); // Current time (when bot detected it)
  const detectedAtLabel = detectedAt.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // Get location (fallback to "N/A" if not available)
  const location = event.details?.location?.address || 'N/A';

  // Build message according to design spec (plain text, no Markdown)
  return `🟥 SEVERE SPEEDING ALERT

🚛 Truck: ${truckNumber}

📍 Location: ${location}

⏱ Time:
${dateLabel}

⚠️ Speed:
Speed limit: ${speedLimitMph} mph
Actual speed: ${actualSpeedMph} mph
Over limit: +${overLimit} mph

⏰ Detected by bot: ${detectedAtLabel}`;
}

/**
 * Format unified event caption for display.
 * Works for both safety events and speeding intervals.
 */
function formatUnifiedEventCaption(event: UnifiedEvent): string {
  const vehicleName = event.vehicleName ?? 'Unknown';
  const timeLocal = formatLocalTime(event.occurredAt);
  
  let behavior = 'Unknown';
  if (event.source === 'speeding' && event.type === 'severe_speeding') {
    behavior = 'Severe Speeding';
    const maxSpeed = event.details?.maxSpeedMph;
    const speedLimit = event.details?.speedLimitMph;
    if (maxSpeed != null && speedLimit != null) {
      behavior += ` (${maxSpeed} mph in ${speedLimit} mph zone)`;
    }
  } else if (event.source === 'safety') {
    const labels = event.details?.behaviorLabels || [];
    behavior = labels.map((l: any) => l.name || l.label).join(', ') || 'Unknown';
  }

  let caption = `⚠️ *Safety Warning*
*Truck:* ${vehicleName}
*Behavior:* ${behavior}
*Time:* ${timeLocal}`;

  // Add location if available (for safety events)
  if (event.details?.location) {
    const lat = event.details.location.latitude;
    const lon = event.details.location.longitude;
    if (lat != null && lon != null) {
      caption += `\n*Location:* ${lat.toFixed(5)}, ${lon.toFixed(5)}
https://www.google.com/maps?q=${lat},${lon}`;
    }
  }

  // Add speed info for speeding intervals
  if (event.source === 'speeding' && event.endedAt) {
    const startTime = formatLocalTime(event.occurredAt);
    const endTime = formatLocalTime(event.endedAt);
    caption += `\n*Duration:* ${startTime} - ${endTime}`;
  }

  return caption;
}

/**
 * Строим общий payload:
 * - caption
 * - videoUrl (ищем по всем возможным полям)
 * 
 * VIDEO URL SELECTION LOGIC (same for both /safety_test and cron):
 * - Priority: downloadForwardVideoUrl > downloadInwardVideoUrl > downloadVideoUrl
 * - This matches the behavior expected by the user
 */
function buildSafetyPayload(
  ev: SafetyEvent,
): { caption: string; videoUrl?: string } {
  const caption = formatSafetyCaption(ev);

  const forward = ev.downloadForwardVideoUrl as string | undefined;
  const inward = (ev as any).downloadInwardVideoUrl as string | undefined;
  const generic = (ev as any).downloadVideoUrl as string | undefined;

  const videoUrl = forward || inward || generic;

  return { caption, videoUrl };
}

/**
 * Mask URL for logging (hide query params and sensitive parts)
 */
function maskVideoUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}...`;
  } catch {
    return url.substring(0, 50) + '...';
  }
}

/**
 * Download video from URL to temporary file
 * Returns path to temp file, or null on failure
 */
async function downloadVideoToTemp(
  url: string,
  eventId: string
): Promise<string | null> {
  const tempDir = '/tmp';
  const tempFile = path.join(tempDir, `safety-video-${eventId}-${Date.now()}.mp4`);

  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: VIDEO_DOWNLOAD_MAX_SIZE_MB * 1024 * 1024,
    });

    const writer = fs.createWriteStream(tempFile);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });

    return tempFile;
  } catch (error: any) {
    console.error(
      `❌ Failed to download video for event ${eventId}:`,
      error.message
    );
    // Clean up if file was partially created
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    return null;
  }
}

/**
 * Shared helper function to send safety alert with video.
 * Used by both /safety_test and cron job to ensure identical behavior.
 * 
 * BEHAVIOR:
 * - Video URL selection: forward > inward > generic (same as buildSafetyPayload)
 * - Sending method: First tries sendVideo with URL (same as /safety_test uses ctx.replyWithVideo)
 * - Fallback: If URL send fails, downloads video and sends as file stream
 * - Error handling: If video fails, still sends text message with error logged (not in chat)
 * 
 * @param event - SafetyEvent from Samsara
 * @param chatId - Telegram chat ID (number)
 * @param caption - Full caption text (may include driver mention)
 * @param dryRun - If true, simulate sending without actually sending to Telegram
 * @returns Object with success status and video URL used (if any)
 */
async function sendSafetyAlertWithVideo(
  event: SafetyEvent,
  chatId: number,
  caption: string,
  dryRun: boolean = false,
  options?: { allowTextIfNoVideo?: boolean }
): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
  const eventId = event.id;
  const vehicleName = event.vehicle?.name ?? 'Unknown';
  const vehicleId = event.vehicle?.id ?? 'Unknown';

  const allowTextIfNoVideo = options?.allowTextIfNoVideo ?? true;

  // 1) Попытка взять URL из самого события (как раньше, как в /safety_test)
  // Priority: forward > inward > generic
  const forward = event.downloadForwardVideoUrl as string | undefined;
  const inward = (event as any).downloadInwardVideoUrl as string | undefined;
  const generic = (event as any).downloadVideoUrl as string | undefined;
  let videoUrl = forward || inward || generic;

  // 2) Если в фиде видео нет — делаем обязательный lookup в Samsara по окну ±5 минут
  if (!videoUrl) {
    console.log(
      `🎯 [sendSafetyAlertWithVideo] Event ${eventId} has no media URLs in feed, performing media lookup...`,
    );
    try {
      const media = await fetchSafetyEventMedia(event);
      if (media.videoUrl) {
        videoUrl = media.videoUrl;
        console.log(
          `🎯 [sendSafetyAlertWithVideo] Event ${eventId} media lookup SUCCESS, URL obtained`,
        );
      } else {
        console.log(
          `🎯 [sendSafetyAlertWithVideo] Event ${eventId} media lookup did not return video`,
        );
      }
    } catch (lookupErr: any) {
      console.error(
        `❌ [sendSafetyAlertWithVideo] Event ${eventId} media lookup error:`,
        lookupErr?.message || lookupErr,
      );
    }
  }

  // Log context
  const maskedUrl = videoUrl ? maskVideoUrl(videoUrl) : 'none';
  let urlHostname = 'none';
  if (videoUrl) {
    try {
      urlHostname = new URL(videoUrl).hostname;
    } catch {
      urlHostname = 'invalid-url';
    }
  }
  
  console.log(
    `📤 [sendSafetyAlertWithVideo] Event ${eventId} | Truck: ${vehicleName} (${vehicleId}) | ChatId: ${chatId} | Video: ${maskedUrl} | Host: ${urlHostname}${dryRun ? ' [DRY RUN]' : ''}`
  );

  if (dryRun) {
    console.log(`🔍 [DRY RUN] Would send to chatId ${chatId}:`);
    console.log(`   Caption: ${caption.substring(0, 100)}...`);
    console.log(`   Video URL: ${maskedUrl}`);
    return { success: true, videoUrl };
  }

  // If no video URL, either send text (default) or, if forbidden, возвращаемся без отправки
  if (!videoUrl) {
    if (!allowTextIfNoVideo) {
      console.log(
        `⏸️ [sendSafetyAlertWithVideo] Event ${eventId} has no video and text-only is disabled (allowTextIfNoVideo=false). Skipping send for now.`,
      );
      return { success: false, error: 'NO_VIDEO_YET' };
    }

    try {
      await bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
      });
      console.log(
        `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only) to chatId ${chatId}`
      );
      return { success: true };
    } catch (error: any) {
      const errorMsg = error.response?.description || error.message || 'Unknown error';
      console.error(
        `❌ [sendSafetyAlertWithVideo] Event ${eventId} failed to send text to chatId ${chatId}:`,
        errorMsg
      );
      return { success: false, error: errorMsg };
    }
  }

  // Try sending video with URL first (same as /safety_test uses ctx.replyWithVideo)
  try {
    await bot.telegram.sendVideo(chatId, videoUrl, {
      caption,
      parse_mode: 'Markdown',
    });
    console.log(
      `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent with video (URL) to chatId ${chatId}`
    );
    return { success: true, videoUrl };
  } catch (urlError: any) {
    const urlErrorMsg = urlError.response?.description || urlError.message || 'Unknown error';
    const urlErrorCode = urlError.response?.error_code;
    
    console.warn(
      `⚠️ [sendSafetyAlertWithVideo] Event ${eventId} failed to send video via URL (code: ${urlErrorCode}): ${urlErrorMsg}`
    );
    console.log(
      `   Attempting fallback: download and send as file stream...`
    );

    // Check if error is a common Telegram fetch error that warrants fallback
    const shouldFallback =
      urlErrorCode === 400 || // Bad Request (often means Telegram can't fetch URL)
      urlErrorCode === 403 || // Forbidden
      urlErrorMsg.toLowerCase().includes('bad request') ||
      urlErrorMsg.toLowerCase().includes('file') ||
      urlErrorMsg.toLowerCase().includes('fetch');

    if (!shouldFallback) {
      // Not a fetch error, probably something else - send text only
      console.log(
        `   Error doesn't warrant fallback, sending text only...`
      );
      try {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
        console.log(
          `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only, video failed) to chatId ${chatId}`
        );
        // Log video failure reason (not in chat message)
        console.log(
          `   (video failed: ${urlErrorMsg})`
        );
        return { success: true, videoUrl, error: urlErrorMsg };
      } catch (textError: any) {
        const textErrorMsg = textError.response?.description || textError.message || 'Unknown error';
        console.error(
          `❌ [sendSafetyAlertWithVideo] Event ${eventId} failed to send text fallback to chatId ${chatId}:`,
          textErrorMsg
        );
        return { success: false, error: textErrorMsg };
      }
    }

    // Fallback: Download video and send as file stream
    const tempFile = await downloadVideoToTemp(videoUrl, eventId);
    if (!tempFile) {
      // Download failed, send text only
      console.log(
        `   Download failed, sending text only...`
      );
      try {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
        console.log(
          `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only, video download failed) to chatId ${chatId}`
        );
        console.log(
          `   (video failed: download error)`
        );
        return { success: true, videoUrl, error: 'Download failed' };
      } catch (textError: any) {
        const textErrorMsg = textError.response?.description || textError.message || 'Unknown error';
        console.error(
          `❌ [sendSafetyAlertWithVideo] Event ${eventId} failed to send text fallback to chatId ${chatId}:`,
          textErrorMsg
        );
        return { success: false, error: textErrorMsg };
      }
    }

    // Send video as file stream
    try {
      const videoStream = fs.createReadStream(tempFile);
      await bot.telegram.sendVideo(chatId, { source: videoStream }, {
        caption,
        parse_mode: 'Markdown',
      });
      console.log(
        `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent with video (file stream fallback) to chatId ${chatId}`
      );
      
      // Clean up temp file
      fs.unlinkSync(tempFile);
      return { success: true, videoUrl };
    } catch (streamError: any) {
      const streamErrorMsg = streamError.response?.description || streamError.message || 'Unknown error';
      console.error(
        `❌ [sendSafetyAlertWithVideo] Event ${eventId} failed to send video stream to chatId ${chatId}:`,
        streamErrorMsg
      );
      
      // Clean up temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      
      // Last resort: send text only
      try {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
        console.log(
          `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only, all video methods failed) to chatId ${chatId}`
        );
        console.log(
          `   (video failed: ${streamErrorMsg})`
        );
        return { success: true, videoUrl, error: streamErrorMsg };
      } catch (textError: any) {
        const textErrorMsg = textError.response?.description || textError.message || 'Unknown error';
        console.error(
          `❌ [sendSafetyAlertWithVideo] Event ${eventId} completely failed to chatId ${chatId}:`,
          textErrorMsg
        );
        return { success: false, error: textErrorMsg };
      }
    }
  }
}

// ================== ОСНОВНАЯ ЛОГИКА SAFETY-НОТИФИКАЦИЙ ==================

const SAFETY_LOOKBACK_MINUTES = 60;
// Сколько минут даём Samsara, чтобы «подвезти» видео до первой попытки отправки
const SAFETY_MEDIA_READY_DELAY_MINUTES = 3;
// Максимальное время ожидания видео; после этого шлём текст даже без видео
const SAFETY_MEDIA_MAX_WAIT_MINUTES = 10;

/**
 * Convert ISO date string to Date object in America/New_York timezone.
 * The Date object will represent the same moment in time but formatted for NY timezone.
 */
function convertToNewYorkTime(dateIso: string | undefined): Date {
  if (!dateIso) {
    return new Date(); // Fallback to now
  }

  // Create Date from ISO string (always UTC)
  const date = new Date(dateIso);

  // Return the Date object (we'll store it as-is; Prisma will handle timezone)
  // The timeLocal field in DB represents the same moment, we just format it for NY when displaying
  return date;
}

async function checkAndNotifySafetyEvents() {
  console.log(
    `🚨 Checking Samsara events (last ${SAFETY_LOOKBACK_MINUTES} min)...`,
  );

  // Calculate time window for safety events (60 minutes)
  const now = new Date();
  const from = new Date(now.getTime() - SAFETY_LOOKBACK_MINUTES * 60 * 1000);

  // Fetch safety events (60-minute window) and speeding intervals (sliding window with 6h+buffer)
  // Speeding uses Samsara-recommended sliding window strategy, separate from safety events
  const [safetyEvents, speedingResult] = await Promise.all([
    getSafetyEventsInWindow({ from, to: now }, 200),
    fetchSpeedingIntervalsWithSlidingWindow(),
  ]);

  // Extract new severe speeding intervals (already deduplicated)
  const speedingIntervals = speedingResult.newToPost;
  const totalSpeedingIntervals = speedingResult.total;
  const severeSpeedingCount = speedingResult.severe;

  // Log counts per source
  console.log(`[SAMSARA] safety events: ${safetyEvents.length} (window: last ${SAFETY_LOOKBACK_MINUTES} min)`);
  console.log(
    `[SAMSARA] speeding intervals: ${totalSpeedingIntervals} (total), ${severeSpeedingCount} (severe), ${speedingIntervals.length} (new to post)`
  );
  console.log(
    `[SAMSARA][SPEEDING] windowStart=${speedingResult.windowStart} windowEnd=${speedingResult.windowEnd}`
  );

  // ==================== PROCESS SAFETY EVENTS (same as /safety_test) ====================
  // Use the same mechanism as /safety_test: process SafetyEvent directly via sendSafetyAlertWithVideo()
  // This ensures 100% identical behavior and reliable video extraction
  
  const relevantSafetyEvents = safetyEvents.filter(isRelevantEvent);
  console.log(`✅ Relevant safety events after filter: ${relevantSafetyEvents.length}`);

  for (const ev of relevantSafetyEvents) {
    // Check if already processed (deduplication)
    const alreadyProcessed = await isEventProcessed(ev.id);
    if (alreadyProcessed) {
      console.log(`↩️ Skipping safety event ${ev.id} — already processed`);
      continue;
    }

    const vehicleName = ev.vehicle?.name ?? 'Unknown';

    // Find chat by vehicle name
    const chat = await findChatByVehicleName(vehicleName);

    if (!chat) {
      console.log(`❓ No chat mapping for vehicle ${vehicleName}`);
      // Log event even if no chat found
      const behavior = ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') || 'Unknown';
      const timeLocal = ev.time ? new Date(ev.time) : new Date();
      await logSafetyEvent(ev, null, behavior, null, timeLocal);
      continue;
    }

    const chatId = Number(chat.telegramChatId);

    // Build driver mention if driver is set
    const chatWithDriver = chat as Chat & {
      driverTgUserId?: bigint | null;
      driverUsername?: string | null;
    };

    let mentionText = '';
    if (chatWithDriver.driverUsername) {
      mentionText = `@${chatWithDriver.driverUsername}`;
    } else if (chatWithDriver.driverTgUserId) {
      mentionText = `[Driver](tg://user?id=${chatWithDriver.driverTgUserId})`;
    }

    // Build caption using same logic as /safety_test
    const { caption } = buildSafetyPayload(ev);
    const finalCaption = mentionText ? `${mentionText}\n\n${caption}` : caption;

    const eventTimeIso = ev.time || ev.occurredAt || ev.startTime;
    let eventAgeMinutes: number | null = null;
    if (eventTimeIso) {
      const eventTime = new Date(eventTimeIso);
      eventAgeMinutes = (now.getTime() - eventTime.getTime()) / (60 * 1000);
    }

    // Если событие слишком свежее — даём время Samsara «подвезти» видео
    if (eventAgeMinutes !== null && eventAgeMinutes < SAFETY_MEDIA_READY_DELAY_MINUTES) {
      console.log(
        `⏳ [SAFETY][MEDIA_WAIT] Skipping event ${ev.id} for now: age=${eventAgeMinutes.toFixed(
          1,
        )}min < readyDelay=${SAFETY_MEDIA_READY_DELAY_MINUTES}min`,
      );
      continue;
    }

    // Решаем стратегию отправки в зависимости от возраста события:
    // - сначала ждём появления видео (готовность Samsara)
    // - если видео так и не появилось до MEDIA_MAX_WAIT, шлём текст

    const ageLabel =
      eventAgeMinutes === null ? 'unknown' : `${eventAgeMinutes.toFixed(1)}min`;
    const allowTextIfNoVideo =
      eventAgeMinutes === null ||
      eventAgeMinutes >= SAFETY_MEDIA_MAX_WAIT_MINUTES;

    console.log(
      `[SAFETY][SEND_STRATEGY] eventId=${ev.id} age=${ageLabel} allowTextIfNoVideo=${allowTextIfNoVideo}`,
    );

    // Use sendSafetyAlertWithVideo() - same as /safety_test
    // Для «молодых» событий мы можем запретить текст, если видео ещё не готово
    try {
      const result = await sendSafetyAlertWithVideo(
        ev,
        chatId,
        finalCaption,
        false, // Not a dry run
        { allowTextIfNoVideo },
      );

      if (result.success && (result.videoUrl || allowTextIfNoVideo)) {
        // Log event to database
        const behavior = ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') || 'Unknown';
        const timeLocal = ev.time ? new Date(ev.time) : new Date();
        const videoUrl = result.videoUrl || null;
        await logSafetyEvent(ev, chatId, behavior, videoUrl, timeLocal);
        
        console.log(
          `✅ Sent safety event ${ev.id} to ${chat.name} (chatId=${chatId})${result.videoUrl ? ' with video' : ' (text only)'}`
        );
      } else if (!result.success && result.error === 'NO_VIDEO_YET' && !allowTextIfNoVideo) {
        // Видео ещё нет, текст слать рано — не помечаем событие обработанным, ждём следующего крона
        console.log(
          `⏳ [SAFETY][MEDIA_WAIT] Event ${ev.id} has no video yet and text-only is disabled. Will retry in next cron run.`,
        );
      } else {
        console.error(
          `❌ Failed to send safety event ${ev.id} to ${chat.name} (chatId=${chatId}): ${result.error || 'Unknown error'}`
        );
        // Still log the event even if sending failed
        const behavior = ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') || 'Unknown';
        const timeLocal = ev.time ? new Date(ev.time) : new Date();
        await logSafetyEvent(ev, chatId, behavior, null, timeLocal);
      }
    } catch (err: any) {
      const errorMsg = err.response?.description || err.message || 'Unknown error';
      console.error(
        `❌ Error sending safety event ${ev.id} to ${chat.name} (chatId=${chatId}): ${errorMsg}`
      );
      // Still log the event even if sending failed
      const behavior = ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') || 'Unknown';
      const timeLocal = ev.time ? new Date(ev.time) : new Date();
      await logSafetyEvent(ev, chatId, behavior, null, timeLocal);
    }
  }

  // ==================== PROCESS SPEEDING INTERVALS (via UnifiedEvent) ====================
  // Speeding intervals continue to use UnifiedEvent pipeline (unchanged)
  
  if (speedingIntervals.length === 0) {
    return; // No speeding intervals to process
  }

  // Normalize speeding intervals into unified events
  const normalizedSpeeding = normalizeSpeedingIntervals(speedingIntervals);

      console.log(
    `📊 Processing ${normalizedSpeeding.length} severe speeding intervals`
  );

  // Process each severe speeding interval
  for (const event of normalizedSpeeding) {
    // Check deduplication: skip if already sent
    const alreadySent = await isEventSent(event.id);
    if (alreadySent) {
      console.log(`↩️ Skipping speeding interval ${event.id} — already sent`);
      continue;
    }

    // Get vehicle name: try vehicleName field, then assetId lookup, then assetId as fallback
    let vehicleName = event.vehicleName;
    if (!vehicleName && event.assetId) {
      vehicleName = getVehicleNameById(event.assetId) || event.assetId;
    }
    if (!vehicleName) {
      vehicleName = 'Unknown';
    }

    // Find chat by vehicle name
    const chat = await findChatByVehicleName(vehicleName);

    if (!chat) {
      console.log(`❓ No chat mapping for vehicle ${vehicleName}`);
      // Log event even if no chat found
      const behavior = 'Severe Speeding';
      const timeLocal = convertToNewYorkTime(event.occurredAt);
      await logUnifiedEvent(event, null, behavior, null, timeLocal);
      continue;
    }

    const chatId = Number(chat.telegramChatId);

    // Build driver mention if driver is set
    const chatWithDriver = chat as Chat & {
      driverTgUserId?: bigint | null;
      driverUsername?: string | null;
    };

    let mentionText = '';
    if (chatWithDriver.driverUsername) {
      mentionText = `@${chatWithDriver.driverUsername}`;
    } else if (chatWithDriver.driverTgUserId) {
      mentionText = `[Driver](tg://user?id=${chatWithDriver.driverTgUserId})`;
    }

    // Send severe speeding message (plain text format)
    try {
      const message = formatSevereSpeedingMessage(event, vehicleName);
      const finalMessage = mentionText ? `${mentionText}\n\n${message}` : message;

      await bot.telegram.sendMessage(chatId, finalMessage, {
        parse_mode: undefined, // Plain text
      });
      console.log(
        `✅ Sent severe speeding event ${event.id} to ${chat.name} (chatId=${chatId})`
      );

      // Mark as sent (dedup)
      await markEventSent(event.id, event.type);

      // Log event to database
      const behavior = 'Severe Speeding';
      const timeLocal = convertToNewYorkTime(event.occurredAt);
      await logUnifiedEvent(event, chatId, behavior, null, timeLocal);
    } catch (err: any) {
      const errorMsg = err.response?.description || err.message || 'Unknown error';
      console.error(
        `❌ Failed to send speeding event ${event.id} to ${chat.name} (chatId=${chatId}): ${errorMsg}`
      );
      // Still log the event even if sending failed
      const behavior = 'Severe Speeding';
      const timeLocal = convertToNewYorkTime(event.occurredAt);
      await logUnifiedEvent(event, chatId, behavior, null, timeLocal);
    }
  }
}

// ================== /severe_speeding_test ==================

/**
 * Test command to check severe speeding events from the last 6 hours.
 * Sends individual messages for each severe speeding event (like /safety_test).
 * 
 * Usage: /severe_speeding_test
 */
bot.command('severe_speeding_test', async (ctx) => {
  // Log immediately to verify command is being called
  console.log('[SEVERE_SPEEDING_TEST] Command handler called', {
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
    fromId: ctx.from?.id,
    username: ctx.from?.username,
  });

  try {
    // Send immediate response first
    await ctx.reply(
      '🔍 Checking severe speeding events from Samsara (last 6 hours)...',
    );
    console.log('[SEVERE_SPEEDING_TEST] Initial reply sent');

    const now = new Date();
    const from = new Date(now.getTime() - 6 * 60 * 60 * 1000); // 6 hours

    console.log(`[SEVERE_SPEEDING_TEST] Fetching intervals from ${from.toISOString()} to ${now.toISOString()}`);

    // Fetch all severe speeding intervals for the last 6 hours
    const result = await fetchSpeedingIntervals({ from, to: now });
    
    console.log(`[SEVERE_SPEEDING_TEST] Found ${result.total} total intervals, ${result.severe.length} severe`);
    
    if (result.severe.length === 0) {
      await ctx.reply('✅ No severe speeding events in the last 6 hours (from API).');
      return;
    }

    // Normalize to UnifiedEvent format
    const normalized = normalizeSpeedingIntervals(result.severe);
    console.log(`[SEVERE_SPEEDING_TEST] Normalized ${normalized.length} events`);

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply('❌ Could not determine chat ID.');
      return;
    }

    // Send individual message for each severe speeding event (like /safety_test)
    let sentCount = 0;
    for (const event of normalized) {
      // Get vehicle name
      let vehicleName = event.vehicleName;
      if (!vehicleName && event.assetId) {
        vehicleName = getVehicleNameById(event.assetId) || event.assetId;
      }
      if (!vehicleName) {
        vehicleName = 'Unknown';
      }

      // Format message using the same function as cron
      const message = formatSevereSpeedingMessage(event, vehicleName);

      try {
        await bot.telegram.sendMessage(chatId, message, {
          parse_mode: undefined, // Plain text
        });
        sentCount++;
        console.log(`[SEVERE_SPEEDING_TEST] Sent event ${event.id} for vehicle ${vehicleName}`);
      } catch (err: any) {
        const errorMsg = err.response?.description || err.message || 'Unknown error';
        console.error(`[SEVERE_SPEEDING_TEST] Failed to send event ${event.id}:`, errorMsg);
        await ctx.reply(
          `⚠️ Failed to send severe speeding event ${event.id}: ${errorMsg}`,
        );
      }
    }

    if (sentCount > 0) {
      console.log(`[SEVERE_SPEEDING_TEST] Successfully sent ${sentCount} event(s)`);
    } else if (normalized.length > 0) {
      await ctx.reply(`⚠️ Found ${normalized.length} events but failed to send all of them.`);
    }
  } catch (err: any) {
    const errorMsg = err.response?.data || err.message || String(err);
    console.error('[SEVERE_SPEEDING_TEST] Error:', err);
    try {
      await ctx.reply(
        `❌ Error fetching severe speeding events: ${errorMsg}`,
        { parse_mode: undefined }
      );
    } catch (replyErr) {
      console.error('[SEVERE_SPEEDING_TEST] Failed to send error message:', replyErr);
    }
  }
});

// ================== /safety_test ==================

bot.command('safety_test', async (ctx) => {
  await ctx.reply(
    '🔍 Checking recent safety events from Samsara (last 60 min, only serious ones) and severe speeding (last 3 hours)...',
  );

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply('❌ Could not determine chat ID.');
    return;
  }

  // Fetch safety events (last 60 minutes)
  const events = await getRecentSafetyEvents(SAFETY_LOOKBACK_MINUTES);
  const relevant = events.filter(isRelevantEvent);

  // Fetch severe speeding events (last 3 hours)
  // Use fetchSpeedingIntervals which filters by severityLevel === 'severe'
  const now = new Date();
  const fromSpeeding = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours
  console.log(`[SAFETY_TEST] Fetching severe speeding from ${fromSpeeding.toISOString()} to ${now.toISOString()}`);
  
  let normalizedSpeeding: UnifiedEvent[] = [];
  try {
    const speedingResult = await fetchSpeedingIntervals({ from: fromSpeeding, to: now });
    console.log(`[SAFETY_TEST] Speeding result: total=${speedingResult.total}, severe=${speedingResult.severe.length}`);
    
    // Log sample severe intervals for debugging
    if (speedingResult.severe.length > 0) {
      const sample = speedingResult.severe[0];
      console.log(`[SAFETY_TEST] Sample severe interval:`, {
        assetId: sample.assetId,
        severityLevel: sample.severityLevel,
        maxSpeedMph: sample.maxSpeedMph,
        speedLimitMph: sample.speedLimitMph,
        startTime: sample.startTime,
      });
    }
    
    const severeSpeedingIntervals = speedingResult.severe;
    normalizedSpeeding = normalizeSpeedingIntervals(severeSpeedingIntervals);
    console.log(`[SAFETY_TEST] Normalized severe speeding: ${normalizedSpeeding.length} events`);
  } catch (err: any) {
    console.error(`[SAFETY_TEST] Error fetching severe speeding:`, err);
    normalizedSpeeding = [];
  }

  // Check if we have any events to show
  if (!relevant.length && normalizedSpeeding.length === 0) {
    await ctx.reply(
      '✅ No relevant safety events (last 60 min) or severe speeding events (last 3 hours).',
    );
    return;
  }

  // Send safety events (same as before)
  if (relevant.length > 0) {
    const top = relevant.slice(0, 5);
    for (const ev of top) {
      const { caption } = buildSafetyPayload(ev);
      
      // Use shared helper to ensure same behavior as cron
      const result = await sendSafetyAlertWithVideo(
        ev,
        chatId,
        caption,
        false // Not a dry run for manual test
      );

      if (!result.success) {
        await ctx.reply(
          `⚠️ Failed to send event ${ev.id}: ${result.error || 'Unknown error'}`,
        );
      }
    }
  }

  // Send severe speeding events (same format as cron)
  if (normalizedSpeeding.length > 0) {
    for (const event of normalizedSpeeding) {
      // Get vehicle name
      let vehicleName = event.vehicleName;
      if (!vehicleName && event.assetId) {
        vehicleName = getVehicleNameById(event.assetId) || event.assetId;
      }
      if (!vehicleName) {
        vehicleName = 'Unknown';
      }

      // Format message using the same function as cron
      const message = formatSevereSpeedingMessage(event, vehicleName);

      try {
        await bot.telegram.sendMessage(chatId, message, {
          parse_mode: undefined, // Plain text
        });
      } catch (err: any) {
        const errorMsg = err.response?.description || err.message || 'Unknown error';
        await ctx.reply(
          `⚠️ Failed to send severe speeding event ${event.id}: ${errorMsg}`,
        );
      }
    }
  }
});

// ================== /test_speeding (DEV/TEST) ==================

/**
 * Test command to verify speeding intervals fetching with window expansion.
 * Admin-only, private chat only.
 * 
 * Usage: /test_speeding [hours]
 * Default: 2 hours lookback
 */
bot.command('test_speeding', requireAdminPrivateChat, async (ctx) => {
  const args = ctx.message?.text?.split(/\s+/) || [];
  const hoursArg = args[1] ? parseInt(args[1], 10) : 2;
  const hours = Math.max(1, Math.min(48, hoursArg || 2));

  await ctx.reply(`🔍 Testing speeding intervals fetch (last ${hours} hours)...`);

  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

  try {
    const result = await fetchSpeedingIntervals({ from, to: now });

    const responseLines: string[] = [];
    responseLines.push(`📊 Speeding Intervals Test Results`);
    responseLines.push(`Time Window: ${from.toISOString()} to ${now.toISOString()}`);
    responseLines.push(`Window Duration: ${hours} hours`);
    responseLines.push('');
    responseLines.push(`Total Intervals: ${result.total}`);
    responseLines.push(`Severe Intervals: ${result.severe.length}`);
    responseLines.push('');

    if (result.severe.length > 0) {
      responseLines.push(`✅ Found ${result.severe.length} severe speeding interval(s):`);
      responseLines.push('');

      // Show first 3 severe intervals as examples
      const examples = result.severe.slice(0, 3);
      for (let i = 0; i < examples.length; i++) {
        const interval = examples[i];
        responseLines.push(`Example ${i + 1}:`);
        responseLines.push(`  Asset ID: ${interval.assetId}`);
        responseLines.push(`  Start: ${new Date(interval.startTime).toISOString()}`);
        responseLines.push(`  End: ${new Date(interval.endTime).toISOString()}`);
        responseLines.push(`  Max Speed: ${interval.maxSpeedMph ?? 'N/A'} mph`);
        responseLines.push(`  Speed Limit: ${interval.speedLimitMph ?? 'N/A'} mph`);
        responseLines.push(`  Severity: ${interval.severityLevel ?? 'N/A'}`);
        if (interval.location?.address) {
          responseLines.push(`  Location: ${interval.location.address}`);
        }
        responseLines.push('');
      }

      if (result.severe.length > 3) {
        responseLines.push(`... and ${result.severe.length - 3} more severe interval(s)`);
      }
    } else {
      responseLines.push(`⚠️ No severe speeding intervals found in this window.`);
      responseLines.push('');
      responseLines.push(`Check logs for window expansion details.`);
    }

    const response = responseLines.join('\n');
    await ctx.reply(response, { parse_mode: undefined });
  } catch (err: any) {
    const errorMsg = err.response?.data || err.message || 'Unknown error';
    await ctx.reply(
      `❌ Error testing speeding intervals: ${errorMsg}`,
      { parse_mode: undefined }
    );
  }
});

// ================== PTI REMINDERS (06:00 NY, Monday-Saturday) ==================

async function sendDailyPtiReminders() {
  console.log('📣 Sending PTI reminders to all chats (06:00)...');
  const chats = await getAllChats();

  if (!chats.length) {
    console.log('⚠️ No chats found in database for PTI reminders');
    return;
  }

  for (const chat of chats) {
    // Map ChatLanguage enum to LanguageCode (already lowercase)
    const lang = chat.language as LanguageCode;
    const baseText =
      ptiMessages[lang] ?? ptiMessages.en ?? 'Daily PTI reminder.';

    // Build driver mention if driver is set
    const chatWithDriver = chat as Chat & {
      driverTgUserId?: bigint | null;
      driverUsername?: string | null;
    };

    let mentionText = '';
    if (chatWithDriver.driverUsername) {
      // Use @username if available
      mentionText = `@${chatWithDriver.driverUsername}`;
    } else if (chatWithDriver.driverTgUserId) {
      // Use Markdown link if only user ID is available
      mentionText = `[Driver](tg://user?id=${chatWithDriver.driverTgUserId})`;
    }

    // Build final message
    const finalText = mentionText
      ? `${mentionText}\n\n${baseText}`
      : baseText;

    const chatId = Number(chat.telegramChatId);

    try {
      await bot.telegram.sendMessage(chatId, finalText, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
      console.log(
        `✅ PTI reminder sent to ${chat.name} (chatId=${chatId}, lang=${chat.language}${mentionText ? ', with driver mention' : ''})`,
      );
    } catch (err) {
      console.error(
        `❌ Failed to send PTI reminder to ${chat.name} (chatId=${chatId})`,
        err,
      );
    }
  }
}

// 06:00 America/New_York (6 AM) - Monday to Saturday (no Sunday)
// Cron day of week: 0=Sunday, 1=Monday, ..., 6=Saturday
cron.schedule(
  '0 6 * * 1-6', // Monday (1) to Saturday (6) at 6 AM, Sunday (0) excluded
  async () => {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];
    console.log(`⏰ [CRON PTI] 06:00 tick (${dayName})`);
    await sendDailyPtiReminders();
  },
  {
    timezone: 'America/New_York',
  },
);

// ================== SAFETY-CRON (каждую минуту) ==================

cron.schedule('* * * * *', async () => {
  console.log('⏰ [CRON SAFETY] tick');
  try {
    await checkAndNotifySafetyEvents();
    
    // Cleanup old sent events once per hour (at minute 0)
    const now = new Date();
    if (now.getMinutes() === 0) {
      await cleanupOldSentEvents(7); // Keep 7 days of dedup keys
    }
  } catch (err) {
    console.error('❌ Error in cron safety check', err);
  }
});

// ================== СТАРТ БОТА ==================

bot.launch().then(async () => {
  console.log('✅ PTI bot is running...');
  // Update truckNames for all chats on startup (so they're visible in Prisma Studio)
  await updateAllChatTruckNames();
});

// Для корректной остановки (telegraf рекомендует)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


// export const ConstruictionZoneFollowingDistance = () => {
//   return 'Construction Zone Following Distance';
// }