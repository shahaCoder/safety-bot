import { PrismaClient, ChatLanguage } from '@prisma/client';
import { log } from 'node:console';

const prisma = new PrismaClient();

// Mimic the current drivers.ts structure for seeding
interface DriverSeedData {
  id: number;
  name: string;
  chatId: number; // Telegram chat ID (can be negative for groups)
  language: 'en' | 'ru' | 'uz';
  trucks: string[]; // Array of Samsara vehicle names
}

  const driverSeeds: DriverSeedData[] = [
    {
      id: 1,
      name: 'PTI TEST RU',
      chatId: -1003477748349,
      language: 'uz',
      trucks: ['Truck 105'],
    },
    {
      id: 2,
      name: 'PTI TEST EN',
      chatId: -1003246951032,
      language: 'uz',
      trucks: ['Truck 712'],
    },
    {
      id: 3,
      name: 'PTI TEST UZ',
      chatId: -1003427092224,
      language: 'ru',
      trucks: ['Truck 10'],
    },
    {
      id: 4,
      name: 'PTI TEST UZ',
      chatId: -1003375592543,
      language: 'uz',
      trucks: ['Truck 1975'],
    },
    {
      id: 5,
      name: 'PTI TEST UZ',
      chatId: -1003242506266,
      language: 'uz',
      trucks: ['Truck 018'],
    },
    {
      id: 6,
      name: 'PTI TEST UZ',
      chatId: -1003406927405,
      language: 'uz',
      trucks: ['Truck 027'],
    },
    {
      id: 7,
      name: 'PTI TEST EN',
      chatId: -1003214745822,
      language: 'en',
      trucks: ['Truck 14'],
    },
    {
      id: 8,
      name: 'PTI TEST UZ',
      chatId: -1003646538715,
      language: 'uz',
      trucks: ['Truck 700'],
    },
    {
      id: 9,
      name: 'PTI TEST UZ',
      chatId: -4170880476,
      language: 'uz',
      trucks: ['Truck 701'],
    },
    {
      id: 10,
      name: 'PTI TEST UZ',
      chatId: -1003463374427,
      language: 'uz',
      trucks: ['Truck 704'],
    },
    {
      id: 11,
      name: 'PTI TEST UZ',
      chatId: -1003388481064,
      language: 'uz',
      trucks: ['Truck 710'],
    },
    {
      id: 12,
      name: 'PTI TEST UZ',
      chatId: -1003447936022,
      language: 'uz',
      trucks: ['Truck 711'],
    },
    {
      id: 13,
      name: 'PTI TEST UZ',
      chatId: -1003688839456,
      language: 'uz',
      trucks: ['Truck 714'],
    },
    {
      id: 14,
      name: 'PTI TEST UZ',
      chatId: -1003493624363,
      language: 'uz',
      trucks: ['Truck 716'],
    },
    {
      id: 15,
      name: 'PTI TEST UZ',
      chatId: -1003512318836,
      language: 'uz',
      trucks: ['Truck 717'],
    },
    {
      id: 16,
      name: 'PTI TEST EN',
      chatId: -1003449100289,
      language: 'en',
      trucks: ['Truck 6974'],
    },
    {
      id: 17,
      name: 'PTI TEST UZ',
      chatId: -1003253543031,
      language: 'uz',
      trucks: ['Truck 777'],
    },
    {
      id: 18,
      name: 'PTI TEST UZ',
      chatId: -1003462238286,
      language: 'uz',
      trucks: ['Truck 702'],
    },
    {
      id: 19,
      name: 'PTI TEST UZ',
      chatId: -1003321162348,
      language: 'uz',
      trucks: ['Truck 705'],
    },
    {
      id: 20,
      name: 'PTI TEST RU',
      chatId: -1003283686253,
      language: 'ru',
      trucks: ['Truck 715'],
    },
    {
      id: 21,
      name: 'PTI TEST UZ',
      chatId: -1003396721081,
      language: 'uz',
      trucks: ['Truck 0690'],
    },
    {
      id: 22,
      name: 'PTI TEST UZ',
      chatId: -5079696595,
      language: 'uz',
      trucks: ['Truck 707'],
    },
    {
      id: 23,
      name: 'PTI TEST UZ',
      chatId: -1003372385236,
      language: 'uz',
      trucks: ['Truck 1982'],
    },
    {
      id: 24,
      name: 'PTI TEST EN',
      chatId: -1003342138533,
      language: 'en',
      trucks: ['Truck 713'],
    }
  ];

// Helper function to map language string to ChatLanguage enum
function mapLanguage(lang: 'en' | 'ru' | 'uz'): ChatLanguage {
  switch (lang) {
    case 'en':
      return ChatLanguage.en;
    case 'ru':
      return ChatLanguage.ru;
    case 'uz':
      return ChatLanguage.uz;
    default:
      return ChatLanguage.en;
  }
}

async function main() {
  console.log('🌱 Starting database seed...');

  // Collect all valid truck names from seed data
  const allValidTruckNames = new Set<string>();
  for (const driver of driverSeeds) {
    for (const truckName of driver.trucks) {
      allValidTruckNames.add(truckName);
    }
  }

  for (const driver of driverSeeds) {
    // Upsert Chat - use telegramChatId as unique identifier
    const chat = await prisma.chat.upsert({
      where: {
        telegramChatId: BigInt(driver.chatId),
      },
      update: {
        name: driver.name,
        language: mapLanguage(driver.language),
        updatedAt: new Date(),
      },
      create: {
        name: driver.name,
        telegramChatId: BigInt(driver.chatId),
        language: mapLanguage(driver.language),
      },
    });

    console.log(`✅ Upserted Chat: ${chat.name} (ID: ${chat.id}, telegramChatId: ${chat.telegramChatId})`);

    // Get existing trucks for this chat
    const existingTrucks = await prisma.truck.findMany({
      where: { chatId: chat.id },
    });

    // Upsert each Truck for this Chat
    const validTruckNamesForChat = new Set(driver.trucks);
    for (const truckName of driver.trucks) {
      const truck = await prisma.truck.upsert({
        where: {
          name: truckName,
        },
        update: {
          chatId: chat.id,
          updatedAt: new Date(),
        },
        create: {
          name: truckName,
          chatId: chat.id,
        },
      });

      console.log(`  ✅ Upserted Truck: ${truck.name} → Chat ID: ${truck.chatId}`);
    }

    // Remove trucks that are no longer in the seed data for this chat
    for (const existingTruck of existingTrucks) {
      if (!validTruckNamesForChat.has(existingTruck.name)) {
        await prisma.truck.delete({
          where: { name: existingTruck.name },
        });
        console.log(`  🗑️  Deleted old Truck: ${existingTruck.name} (no longer in seed data for this chat)`);
      }
    }
  }

  // Remove trucks that are not in any seed data at all
  const allTrucks = await prisma.truck.findMany();
  for (const truck of allTrucks) {
    if (!allValidTruckNames.has(truck.name)) {
      await prisma.truck.delete({
        where: { name: truck.name },
      });
      console.log(`  🗑️  Deleted orphaned Truck: ${truck.name} (not in seed data)`);
    }
  }

  console.log('✅ Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

  const alertMsg  (text: string) => {
    log
  }