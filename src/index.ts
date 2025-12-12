import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { Chat } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

import { ptiMessages } from './messages';
import { getRecentSafetyEvents, SafetyEvent } from './samsara';
import {
  findChatByVehicleName,
  logSafetyEvent,
  isEventProcessed,
  getAllChats,
  findChatByTelegramChatId,
  updateChatMentionTemplate,
  setChatDriver,
  clearChatDriver,
} from './repository';
import { requireAdminPrivateChat } from './guards/isAdmin';
import { handleDebugSafety } from './commands/debugSafety';

dotenv.config();

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
  dryRun: boolean = false
): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
  const eventId = event.id;
  const vehicleName = event.vehicle?.name ?? 'Unknown';
  const vehicleId = event.vehicle?.id ?? 'Unknown';

  // Select video URL using same logic as buildSafetyPayload
  // Priority: forward > inward > generic
  const forward = event.downloadForwardVideoUrl as string | undefined;
  const inward = (event as any).downloadInwardVideoUrl as string | undefined;
  const generic = (event as any).downloadVideoUrl as string | undefined;
  const videoUrl = forward || inward || generic;

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

  // If no video URL, just send text message
  if (!videoUrl) {
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
    `🚨 Checking Samsara safety events (last ${SAFETY_LOOKBACK_MINUTES} min)...`,
  );

  const events = await getRecentSafetyEvents(SAFETY_LOOKBACK_MINUTES);
  console.log(`📊 Got ${events.length} events from Samsara`);

  if (!events.length) {
    console.log('No safety events from API in this window');
    return;
  }

  for (const ev of events) {
    const behaviorRaw =
      ev.behaviorLabels?.map((l) => `${l.label}|${l.name}`).join(', ') ||
      'no labels';
    console.log(`🧾 Event ${ev.id} labels = ${behaviorRaw}`);
  }

  const relevant = events.filter(isRelevantEvent);
  console.log(`✅ Relevant events after filter: ${relevant.length}`);

  if (!relevant.length) {
    console.log('No relevant safety events in whitelist');
    return;
  }

  for (const ev of relevant) {
    // Check if already processed using database
    const alreadyProcessed = await isEventProcessed(ev.id);
    if (alreadyProcessed) {
      console.log(`↩️ Skipping ${ev.id} — already processed`);
      continue;
    }

    const vehicleName = ev.vehicle?.name;
    const chat = await findChatByVehicleName(vehicleName);

    if (!chat) {
      console.log(`❓ No chat mapping for vehicle ${vehicleName}`);
      // Log event even if no chat found (sentToChatId will be null)
      const behavior =
        ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') ??
        'Unknown';
      const timeLocal = convertToNewYorkTime(ev.time);
      await logSafetyEvent(ev, null, behavior, undefined, timeLocal);
      continue;
    }

    const chatId = Number(chat.telegramChatId);
    const { caption } = buildSafetyPayload(ev);

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

    // Build final caption with driver mention
    const finalCaption = mentionText
      ? `${mentionText}\n\n${caption}`
      : caption;

    // Build behavior string for logging
    const behavior =
      ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') ??
      'Unknown';

    // Convert time to Date object for database
    const timeLocal = convertToNewYorkTime(ev.time);

    // Use shared helper function (same as /safety_test)
    // This ensures identical behavior: same video selection, same sending method, same error handling
    const result = await sendSafetyAlertWithVideo(
      ev,
      chatId,
      finalCaption,
      DRY_RUN_MODE
    );

    // Extract video URL from event (same logic as helper uses)
    const forward = ev.downloadForwardVideoUrl as string | undefined;
    const inward = (ev as any).downloadInwardVideoUrl as string | undefined;
    const generic = (ev as any).downloadVideoUrl as string | undefined;
    const videoUrl = forward || inward || generic;

    // Log event to database (always log, even if sending failed)
    await logSafetyEvent(ev, chatId, behavior, videoUrl, timeLocal);

    if (result.success) {
      console.log(
        `✅ Sent safety event ${ev.id} for ${vehicleName} to ${chat.name} (chatId=${chatId})${result.error ? ' (video failed, text sent)' : ''}`,
      );
    } else {
      console.error(
        `❌ Failed to send safety event ${ev.id} to ${chat.name} (chatId=${chatId}): ${result.error}`,
      );
    }
  }
}

// ================== /safety_test ==================

bot.command('safety_test', async (ctx) => {
  await ctx.reply(
    '🔍 Checking recent safety events from Samsara (last 60 min, only serious ones)...',
  );

  const events = await getRecentSafetyEvents(SAFETY_LOOKBACK_MINUTES);

  if (!events.length) {
    await ctx.reply('✅ No safety events in the last 60 minutes (from API).');
    return;
  }

  const relevant = events.filter(isRelevantEvent);

  if (!relevant.length) {
    await ctx.reply(
      '✅ No relevant safety events (only Following Distance / minor stuff).',
    );
    return;
  }

  const top = relevant.slice(0, 5);
  const chatId = ctx.chat?.id;

  if (!chatId) {
    await ctx.reply('❌ Could not determine chat ID.');
    return;
  }

  // Use shared helper function (same as cron)
  // Note: /safety_test doesn't add driver mentions, so we use caption directly
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
});

// ================== PTI REMINDERS (06:00 и 16:00 NY) ==================

async function sendDailyPtiReminders() {
  console.log('📣 Sending PTI reminders to all chats...');
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

// 06:00 America/New_York (6 AM)
cron.schedule(
  '0 6 * * *',
  async () => {
    console.log('⏰ [CRON PTI] 06:00 tick');
    await sendDailyPtiReminders();
  },
  {
    timezone: 'America/New_York',
  },
);

// 16:00 America/New_York (4 PM)
cron.schedule(
  '0 16 * * *',
  async () => {
    console.log('⏰ [CRON PTI] 16:00 tick');
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
  } catch (err) {
    console.error('❌ Error in cron safety check', err);
  }
});

// ================== СТАРТ БОТА ==================

bot.launch().then(() => {
  console.log('✅ PTI bot is running...');
});

// Для корректной остановки (telegraf рекомендует)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


// export const ConstruictionZoneFollowingDistance = () => {
//   return 'Construction Zone Following Distance';
// }