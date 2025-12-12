import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import cron from 'node-cron';

import { ptiMessages } from './messages';
import { getRecentSafetyEvents, SafetyEvent } from './samsara';
import {
  findChatByVehicleName,
  logSafetyEvent,
  isEventProcessed,
  getAllChats,
} from './repository';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');
}

const bot = new Telegraf(BOT_TOKEN);


// Языки для PTI-сообщений
type LanguageCode = 'en' | 'ru' | 'uz';

// ================== ГЛОБАЛЬНЫЕ ФИЛЬТРЫ ==================

// Игнорировать все личные чаты 
bot.use((ctx, next) => {
  if (ctx.chat?.type === 'private') {
    return; // молчим
  }
  return next();
});

// Игнорировать /start (если кто-то вдруг напишет в группу)
bot.start(() => {
  // ничего не отвечаем
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
    const { caption, videoUrl } = buildSafetyPayload(ev);

    // Build behavior string for logging
    const behavior =
      ev.behaviorLabels?.map((l) => l.name || l.label).join(', ') ??
      'Unknown';

    // Convert time to Date object for database
    const timeLocal = convertToNewYorkTime(ev.time);

    try {
      if (videoUrl) {
        await bot.telegram.sendVideo(chatId, videoUrl, {
          caption,
          parse_mode: 'Markdown',
        });
      } else {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
      }

      // Log successful event to database
      await logSafetyEvent(ev, chatId, behavior, videoUrl, timeLocal);

      console.log(
        `✅ Sent safety event ${ev.id} for ${vehicleName} to ${chat.name} (chatId=${chatId})`,
      );
    } catch (err) {
      console.error(
        `❌ Failed to send safety event ${ev.id} to ${chat.name} (chatId=${chatId})`,
        err,
      );
      // Still log the event even if sending failed (sentToChatId will be set, but send failed)
      await logSafetyEvent(ev, chatId, behavior, videoUrl, timeLocal);
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

  for (const ev of top) {
    const { caption, videoUrl } = buildSafetyPayload(ev);

    if (videoUrl) {
      await ctx.replyWithVideo(videoUrl, {
        caption,
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply(caption, { parse_mode: 'Markdown' });
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
    const message =
      ptiMessages[lang] ?? ptiMessages.en ?? 'Daily PTI reminder.';

    const chatId = Number(chat.telegramChatId);

    try {
      await bot.telegram.sendMessage(chatId, message);
      console.log(
        `✅ PTI reminder sent to ${chat.name} (chatId=${chatId}, lang=${chat.language})`,
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


