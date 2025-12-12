import { PrismaClient, Chat } from '@prisma/client';
import { SafetyEvent } from './samsara';

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
 * Check if a safety event has already been processed.
 * Uses the database instead of in-memory Set.
 *
 * @param samsaraEventId - Samsara event ID
 * @returns true if event exists in database
 */
export async function isEventProcessed(
  samsaraEventId: string
): Promise<boolean> {
  try {
    const existing = await prisma.safetyEventLog.findUnique({
      where: {
        samsaraEventId,
      },
      select: {
        id: true,
      },
    });
    return existing !== null;
  } catch (error) {
    console.error(
      `❌ Error checking if event ${samsaraEventId} is processed:`,
      error
    );
    return false; // If error, assume not processed to avoid skipping events
  }
}

/**
 * Get all Chats from database for PTI reminders.
 *
 * @returns Array of all Chats with their language settings
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

// Export Prisma client for direct use if needed
export { prisma };

