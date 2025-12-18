import { LanguageCode } from './messages';

export interface DriverConfig {
  id: number;
  name: string;
  chatId: number;          // Telegram chat id группы/чата
  language: LanguageCode;  // 'en' | 'ru' | 'uz'
  trucks: string[];        // названия траков из Samsara: vehicle.name
}

// NOTE: This file is DEPRECATED - chat mappings are now stored in database (prisma/seed.ts)
// This file is kept for backward compatibility but should not be used for new mappings.
// Multiple trucks may share the same chatId if they belong to the same driver/group.

export const drivers: DriverConfig[] = [
  {
    id: 1,
    name: 'PTI TEST UZ',
    chatId: -1003477748349,      // пример: твой RU test chat id
    language: 'uz',
    trucks: ['Truck 105'],       // какие траки относятся к этой группе
  },
  {
    id: 2,
    name: 'PTI TEST UZ',
    chatId: -1003246951032,      // EN test chat id
    language: 'uz',
    trucks: ['Truck 712'],
  },
  {
    id: 3,
    name: 'PTI TEST RU',
    chatId: -1003474651531,      // UZ test chat id
    language: 'ru',
    trucks: ['Truck 10'],
  },
  {
    id: 4,
    name: 'PTI TEST UZ',
    chatId: -1003375592543,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 1975'],
  },
  {
    id: 5,
    name: 'PTI TEST UZ',
    chatId: -1003242506266,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 018'],
  },
  {
    id: 6,
    name: 'PTI TEST UZ',
    chatId: -1003474651531,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 027'],
  },
  {
    id: 7,
    name: 'PTI TEST UZ',
    chatId: -1003474651531,      // UZ test chat id
    language: 'en',
    trucks: ['Truck 195'],
  },
  {
    id: 8,
    name: 'PTI TEST UZ',
    chatId: -1003474651531,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 700'],
  },
  {
    id: 9,
    name: 'PTI TEST UZ',
    chatId: -4170880476,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 701'],
  },
  {
    id: 10,
    name: 'PTI TEST UZ',
    chatId: -1003463374427,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 704'],
  },
  {
    id: 11,
    name: 'PTI TEST UZ',
    chatId: -1003474651531,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 710'],
  },
  {
    id: 12,
    name: 'PTI TEST UZ',
    chatId: -1003474651531,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 711'],
  },
  {
    id: 13,
    name: 'PTI TEST UZ',
    chatId: -4998245805,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 714'],
  },
  {
    id: 14,
    name: 'PTI TEST UZ',
    chatId: -1003493624363,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 716'],
  },
  {
    id: 15,
    name: 'PTI TEST EN',
    chatId: -4285641809,      // UZ test chat id
    language: 'en',
    trucks: ['Truck 717'],
  },
  {
    id: 16,
    name: 'PTI TEST EN',
    chatId: -1003449100289,      // UZ test chat id
    language: 'en',
    trucks: ['Truck 6974'],
  },
  {
    id: 17,
    name: 'PTI TEST UZ',
    chatId: -1003253543031,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 777'],
  },
  {
    id: 18,
    name: 'PTI TEST UZ',
    chatId: -1003474651531,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 702'],
  },
  {
    id: 19,
    name: 'PTI TEST UZ',
    chatId: -1003321162348,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 705'],
  },
  {
    id: 20,
    name: 'PTI TEST RU',
    chatId: -1003474651531,      // UZ test chat id
    language: 'ru',
    trucks: ['Truck 715'],
  },
  {
    id: 21,
    name: 'PTI TEST UZ',
    chatId: -1003396721081,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 0690'],
  },
  {
    id: 22,
    name: 'PTI TEST UZ',
    chatId: -5079696595,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 707'],
  },
  {
    id: 23,
    name: 'PTI TEST UZ',
    chatId: -1003372385236,      // UZ test chat id
    language: 'uz',
    trucks: ['Truck 1982'],
  },
];  

export function findDriverByVehicleName(
  vehicleName?: string
): DriverConfig | undefined {
  if (!vehicleName) return undefined;
  return drivers.find((d) => d.trucks.includes(vehicleName));
}
