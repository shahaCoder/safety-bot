import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Updating truckNames for all chats...');

  const chats = await prisma.chat.findMany({
    include: {
      trucks: {
        orderBy: {
          name: 'asc',
        },
      },
    },
  });

  console.log(`Found ${chats.length} chats`);

  for (const chat of chats) {
    const truckNames = chat.trucks.length > 0
      ? chat.trucks.map((t) => t.name).sort().join(', ')
      : null;

    await prisma.chat.update({
      where: { id: chat.id },
      data: { truckNames },
    });

    console.log(
      `✅ Chat "${chat.name}" (ID: ${chat.id}): ${truckNames || 'no trucks'}`
    );
  }

  console.log(`\n✅ Updated truckNames for ${chats.length} chats`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

