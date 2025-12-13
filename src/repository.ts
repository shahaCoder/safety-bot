import { PrismaClient, Chat } from '@prisma/client';
import { SafetyEvent } from './samsara';
import { UnifiedEvent } from './services/eventNormalize';

const prisma = new PrismaClient();

/**
 * Find Chat by vehicle name from Samsara.
 * Looks up the Truck by name and returns the associated Chat.
 *
 * @param vehicleName - Vehicle name from Samsara event (e.g., "Truck 105")
 * @returns Chat with language and telegramChatId, or null if not found
 */
export async function findChatByVehicleName(
  vehicleName: string | null | undefined
): Promise<Chat | null> {
  if (!vehicleName) {
    return null;
  }

  try {
    const truck = await prisma.truck.findUnique({
      where: {
        name: vehicleName,
      },
      include: {
        chat: true,
      },
    });

    return truck?.chat ?? null;
  } catch (error) {
    console.error(`❌ Error finding chat for vehicle ${vehicleName}:`, error);
    return null;
  }
}

/**
 * Log a safety event to the database.
 * Stores the event details including raw JSON for debugging.
 *
 * @param event - Original Samsara SafetyEvent
 * @param chatId - Telegram chat ID where the event was sent (BigInt or number)
 * @param behavior - Behavior description string (e.g., "Speeding, Harsh Brake")
 * @param videoUrl - Optional video URL that was sent
 * @param timeLocal - Event time already converted to America/New_York timezone
 */
export async function logSafetyEvent(
  event: SafetyEvent,
  chatId: BigInt | number | null | undefined,
  behavior: string,
  videoUrl: string | null | undefined,
  timeLocal: Date
): Promise<void> {
  try {
    await prisma.safetyEventLog.upsert({
      where: {
        samsaraEventId: event.id,
      },
      update: {
        vehicleName: event.vehicle?.name ?? 'Unknown',
        behavior,
        timeLocal,
        latitude: event.location?.latitude ?? null,
        longitude: event.location?.longitude ?? null,
        sentToChatId: chatId ? BigInt(Number(chatId)) : null,
        videoUrl: videoUrl ?? null,
        rawJson: event as any, // Store full raw JSON
        updatedAt: new Date(),
      },
      create: {
        samsaraEventId: event.id,
        vehicleName: event.vehicle?.name ?? 'Unknown',
        behavior,
        timeLocal,
        latitude: event.location?.latitude ?? null,
        longitude: event.location?.longitude ?? null,
        sentToChatId: chatId ? BigInt(Number(chatId)) : null,
        videoUrl: videoUrl ?? null,
        rawJson: event as any, // Store full raw JSON
      },
    });
  } catch (error) {
    console.error(`❌ Error logging safety event ${event.id}:`, error);
    // Don't throw - logging errors shouldn't break the bot
  }
}

/**
 * Log a unified event (safety or speeding) to the database.
 * Works with both safety events and speeding intervals.
 *
 * @param event - UnifiedEvent (normalized from safety or speeding)
 * @param chatId - Telegram chat ID where the event was sent (BigInt or number)
 * @param behavior - Behavior description string (e.g., "Severe Speeding", "Harsh Brake")
 * @param videoUrl - Optional video URL that was sent
 * @param timeLocal - Event time already converted to America/New_York timezone
 */
export async function logUnifiedEvent(
  event: UnifiedEvent,
  chatId: BigInt | number | null | undefined,
  behavior: string,
  videoUrl: string | null | undefined,
  timeLocal: Date
): Promise<void> {
  try {
    await prisma.safetyEventLog.upsert({
      where: {
        samsaraEventId: event.id, // Works for both safety events and speeding intervals
      },
      update: {
        vehicleName: event.vehicleName ?? 'Unknown',
        behavior,
        timeLocal,
        latitude: event.details?.location?.latitude ?? null,
        longitude: event.details?.location?.longitude ?? null,
        sentToChatId: chatId ? BigInt(Number(chatId)) : null,
        videoUrl: videoUrl ?? null,
        rawJson: event as any, // Store full unified event JSON
        updatedAt: new Date(),
      },
      create: {
        samsaraEventId: event.id,
        vehicleName: event.vehicleName ?? 'Unknown',
        behavior,
        timeLocal,
        latitude: event.details?.location?.latitude ?? null,
        longitude: event.details?.location?.longitude ?? null,
        sentToChatId: chatId ? BigInt(Number(chatId)) : null,
        videoUrl: videoUrl ?? null,
        rawJson: event as any, // Store full unified event JSON
      },
    });
  } catch (error) {
    console.error(`❌ Error logging unified event ${event.id}:`, error);
    // Don't throw - logging errors shouldn't break the bot
  }
}

/**
 * Check if an event has already been processed.
 * Uses the database instead of in-memory Set.
 * 
 * Supports both:
 * - Safety events: uses Samsara event ID directly
 * - Speeding intervals: uses stable key like "speeding:assetId:startTime:endTime"
 *
 * @param eventId - Unified event ID (can be Samsara event ID or stable key)
 * @returns true if event exists in database
 */
export async function isEventProcessed(eventId: string): Promise<boolean> {
  try {
    const existing = await prisma.safetyEventLog.findUnique({
      where: {
        samsaraEventId: eventId, // Works for both safety events and speeding intervals
      },
      select: {
        id: true,
      },
    });
    return existing !== null;
  } catch (error) {
    console.error(
      `❌ Error checking if event ${eventId} is processed:`,
      error
    );
    return false; // If error, assume not processed to avoid skipping events
  }
}

/**
 * Get all Chats from database for PTI reminders.
 *
 * @returns Array of all Chats with their language settings and mentionTemplate
 */
export async function getAllChats(): Promise<Chat[]> {
  try {
    return await prisma.chat.findMany({
      orderBy: {
        id: 'asc',
      },
    });
  } catch (error) {
    console.error('❌ Error fetching all chats:', error);
    return [];
  }
}

/**
 * Find Chat by Telegram chat ID.
 *
 * @param telegramChatId - Telegram chat ID (BigInt)
 * @returns Chat or null if not found
 */
export async function findChatByTelegramChatId(
  telegramChatId: bigint
): Promise<Chat | null> {
  try {
    return await prisma.chat.findUnique({
      where: {
        telegramChatId,
      },
    });
  } catch (error) {
    console.error(
      `❌ Error finding chat by telegramChatId ${telegramChatId}:`,
      error
    );
    return null;
  }
}

/**
 * Update mention template for a chat.
 *
 * @param telegramChatId - Telegram chat ID (BigInt)
 * @param mentionTemplate - Mention template string (can be null to clear)
 * @returns Updated Chat or null if not found
 */
export async function updateChatMentionTemplate(
  telegramChatId: bigint,
  mentionTemplate: string | null
): Promise<Chat | null> {
  try {
    // First check if chat exists
    const existing = await prisma.chat.findUnique({
      where: {
        telegramChatId,
      },
    });

    if (!existing) {
      console.log(
        `⚠️ Chat not found for telegramChatId ${telegramChatId}, cannot update mentionTemplate`
      );
      return null;
    }

    // Update the chat
    return await prisma.chat.update({
      where: {
        telegramChatId,
      },
      data: {
        mentionTemplate,
      },
    });
  } catch (error) {
    console.error(
      `❌ Error updating mention template for chat ${telegramChatId}:`,
      error
    );
    return null;
  }
}

/**
 * Set driver information for a chat.
 *
 * @param telegramChatId - Telegram chat ID (BigInt)
 * @param user - Driver user information from Telegram
 * @returns Updated Chat or null if not found
 */
export async function setChatDriver(
  telegramChatId: bigint,
  user: {
    id: bigint;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
  }
): Promise<Chat | null> {
  try {
    // First check if chat exists
    const existing = await prisma.chat.findUnique({
      where: {
        telegramChatId,
      },
    });

    if (!existing) {
      console.log(
        `⚠️ Chat not found for telegramChatId ${telegramChatId}, cannot set driver`
      );
      return null;
    }

    // Update the chat with driver information
    return await prisma.chat.update({
      where: {
        telegramChatId,
      },
      data: {
        driverTgUserId: user.id,
        driverFirstName: user.firstName ?? null,
        driverLastName: user.lastName ?? null,
        driverUsername: user.username ?? null,
      },
    });
  } catch (error) {
    console.error(
      `❌ Error setting driver for chat ${telegramChatId}:`,
      error
    );
    return null;
  }
}

/**
 * Clear driver information for a chat.
 *
 * @param telegramChatId - Telegram chat ID (BigInt)
 * @returns Updated Chat or null if not found
 */
export async function clearChatDriver(
  telegramChatId: bigint
): Promise<Chat | null> {
  try {
    // First check if chat exists
    const existing = await prisma.chat.findUnique({
      where: {
        telegramChatId,
      },
    });

    if (!existing) {
      console.log(
        `⚠️ Chat not found for telegramChatId ${telegramChatId}, cannot clear driver`
      );
      return null;
    }

    // Clear driver fields
    return await prisma.chat.update({
      where: {
        telegramChatId,
      },
      data: {
        driverTgUserId: null,
        driverFirstName: null,
        driverLastName: null,
        driverUsername: null,
      },
    });
  } catch (error) {
    console.error(
      `❌ Error clearing driver for chat ${telegramChatId}:`,
      error
    );
    return null;
  }
}

/**
 * Check if an event has already been sent (deduplication).
 * 
 * @param eventId - Stable event ID (e.g., "speeding:assetId:startTime:endTime")
 * @returns true if event was already sent
 */
export async function isEventSent(eventId: string): Promise<boolean> {
  try {
    const existing = await prisma.sentEvent.findUnique({
      where: {
        id: eventId,
      },
      select: {
        id: true,
      },
    });
    return existing !== null;
  } catch (error) {
    console.error(
      `❌ Error checking if event ${eventId} was sent:`,
      error
    );
    return false; // If error, assume not sent to avoid skipping events
  }
}

/**
 * Mark an event as sent (deduplication).
 * 
 * @param eventId - Stable event ID
 * @param eventType - Event type (e.g., "severe_speeding")
 */
export async function markEventSent(
  eventId: string,
  eventType: string
): Promise<void> {
  try {
    await prisma.sentEvent.upsert({
      where: {
        id: eventId,
      },
      update: {
        type: eventType,
        sentAt: new Date(),
      },
      create: {
        id: eventId,
        type: eventType,
        sentAt: new Date(),
      },
    });
  } catch (error) {
    console.error(`❌ Error marking event ${eventId} as sent:`, error);
    // Don't throw - marking errors shouldn't break the bot
  }
}

/**
 * Clean up old sent events (dedup keys) older than specified days.
 * Used to prevent unbounded growth of the sent_events table.
 * 
 * @param daysOld - Delete events older than this many days (default: 7)
 * @returns Number of deleted events
 */
export async function cleanupOldSentEvents(daysOld: number = 7): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await prisma.sentEvent.deleteMany({
      where: {
        sentAt: {
          lt: cutoffDate,
        },
      },
    });

    if (result.count > 0) {
      console.log(`🧹 Cleaned up ${result.count} old sent events (older than ${daysOld} days)`);
    }

    return result.count;
  } catch (error) {
    console.error(`❌ Error cleaning up old sent events:`, error);
    return 0;
  }
}

// Export Prisma client for direct use if needed
export { prisma };

