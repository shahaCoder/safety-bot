/**
 * Test script for sendSafetyAlertWithVideo helper function
 * 
 * Usage:
 *   DRY_RUN_MODE=true TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx ts-node src/test-safety-helper.ts
 * 
 * Or with a sample event JSON file:
 *   DRY_RUN_MODE=true TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx ts-node src/test-safety-helper.ts sample-event.json
 */

import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { SafetyEvent } from './samsara';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_CHAT_ID
  ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
  : null;
const DRY_RUN = process.env.DRY_RUN_MODE === 'true';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

if (!TEST_CHAT_ID && !DRY_RUN) {
  console.error('❌ TELEGRAM_CHAT_ID is required when not in dry run mode');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Configuration (same as in index.ts)
const VIDEO_DOWNLOAD_MAX_SIZE_MB = parseInt(
  process.env.VIDEO_DOWNLOAD_MAX_SIZE_MB || '25',
  10
);
const VIDEO_DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.VIDEO_DOWNLOAD_TIMEOUT_MS || '30000',
  10
);

// Copy helper functions from index.ts (for testing)
function maskVideoUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}...`;
  } catch {
    return url.substring(0, 50) + '...';
  }
}

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
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    return null;
  }
}

async function sendSafetyAlertWithVideo(
  event: SafetyEvent,
  chatId: number,
  caption: string,
  dryRun: boolean = false
): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
  const eventId = event.id;
  const vehicleName = event.vehicle?.name ?? 'Unknown';
  const vehicleId = event.vehicle?.id ?? 'Unknown';

  const forward = event.downloadForwardVideoUrl as string | undefined;
  const inward = (event as any).downloadInwardVideoUrl as string | undefined;
  const generic = (event as any).downloadVideoUrl as string | undefined;
  const videoUrl = forward || inward || generic;

  const maskedUrl = videoUrl ? maskVideoUrl(videoUrl) : 'none';
  const urlHostname = videoUrl ? new URL(videoUrl).hostname : 'none';

  console.log(
    `📤 [sendSafetyAlertWithVideo] Event ${eventId} | Truck: ${vehicleName} (${vehicleId}) | ChatId: ${chatId} | Video: ${maskedUrl} | Host: ${urlHostname}${dryRun ? ' [DRY RUN]' : ''}`
  );

  if (dryRun) {
    console.log(`🔍 [DRY RUN] Would send to chatId ${chatId}:`);
    console.log(`   Caption: ${caption.substring(0, 100)}...`);
    console.log(`   Video URL: ${maskedUrl}`);
    return { success: true, videoUrl };
  }

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
    console.log(`   Attempting fallback: download and send as file stream...`);

    const shouldFallback =
      urlErrorCode === 400 ||
      urlErrorCode === 403 ||
      urlErrorMsg.toLowerCase().includes('bad request') ||
      urlErrorMsg.toLowerCase().includes('file') ||
      urlErrorMsg.toLowerCase().includes('fetch');

    if (!shouldFallback) {
      console.log(`   Error doesn't warrant fallback, sending text only...`);
      try {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
        console.log(
          `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only, video failed) to chatId ${chatId}`
        );
        console.log(`   (video failed: ${urlErrorMsg})`);
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

    const tempFile = await downloadVideoToTemp(videoUrl, eventId);
    if (!tempFile) {
      console.log(`   Download failed, sending text only...`);
      try {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
        console.log(
          `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only, video download failed) to chatId ${chatId}`
        );
        console.log(`   (video failed: download error)`);
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

    try {
      const videoStream = fs.createReadStream(tempFile);
      await bot.telegram.sendVideo(chatId, { source: videoStream }, {
        caption,
        parse_mode: 'Markdown',
      });
      console.log(
        `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent with video (file stream fallback) to chatId ${chatId}`
      );
      fs.unlinkSync(tempFile);
      return { success: true, videoUrl };
    } catch (streamError: any) {
      const streamErrorMsg = streamError.response?.description || streamError.message || 'Unknown error';
      console.error(
        `❌ [sendSafetyAlertWithVideo] Event ${eventId} failed to send video stream to chatId ${chatId}:`,
        streamErrorMsg
      );
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      try {
        await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
        });
        console.log(
          `✅ [sendSafetyAlertWithVideo] Event ${eventId} sent (text only, all video methods failed) to chatId ${chatId}`
        );
        console.log(`   (video failed: ${streamErrorMsg})`);
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

// Main test function
async function main() {
  console.log('🧪 Testing sendSafetyAlertWithVideo helper function');
  console.log(`   Dry run mode: ${DRY_RUN}`);
  console.log(`   Test chat ID: ${TEST_CHAT_ID || 'N/A (dry run)'}`);
  console.log('');

  // Sample event (or load from file)
  let sampleEvent: SafetyEvent;

  const eventFile = process.argv[2];
  if (eventFile && fs.existsSync(eventFile)) {
    console.log(`📄 Loading event from file: ${eventFile}`);
    const fileContent = fs.readFileSync(eventFile, 'utf-8');
    sampleEvent = JSON.parse(fileContent);
  } else {
    // Default sample event
    console.log('📄 Using default sample event');
    sampleEvent = {
      id: 'test-event-123',
      time: new Date().toISOString(),
      vehicle: {
        id: 'test-vehicle-456',
        name: 'Test Truck 105',
      },
      downloadForwardVideoUrl: 'https://example.com/video.mp4',
      location: {
        latitude: 40.7128,
        longitude: -74.0060,
      },
      behaviorLabels: [
        {
          label: 'speeding',
          name: 'Speeding',
        },
      ],
    };
  }

  const testCaption = `⚠️ *Safety Warning*
*Truck:* ${sampleEvent.vehicle?.name ?? 'Unknown'}
*Behavior:* ${sampleEvent.behaviorLabels?.map((l) => l.name || l.label).join(', ') ?? 'Unknown'}
*Time:* ${sampleEvent.time ? new Date(sampleEvent.time).toLocaleString() : 'unknown time'}`;

  const chatId = TEST_CHAT_ID || 123456789; // Dummy ID for dry run

  console.log('');
  console.log('🚀 Calling sendSafetyAlertWithVideo...');
  console.log('');

  const result = await sendSafetyAlertWithVideo(
    sampleEvent,
    chatId,
    testCaption,
    DRY_RUN
  );

  console.log('');
  console.log('📊 Result:');
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log('');
    console.log('✅ Test completed successfully!');
    if (result.error) {
      console.log(`   Note: Video failed but text was sent (${result.error})`);
    }
  } else {
    console.log('');
    console.log('❌ Test failed!');
    process.exit(1);
  }

  // Cleanup
  await bot.stop();
}

main().catch((error) => {
  console.error('❌ Test script error:', error);
  process.exit(1);
});

