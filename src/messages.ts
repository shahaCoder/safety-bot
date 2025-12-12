// src/messages.ts

export const ptiMessages = {
  en: `Daily PTI Reminder

Hello, driver.
Please complete your Daily PTI. Make sure you record a clear video of the following:

- Dashboard (no warning lights)
- Tire PSI (all tires properly inflated)
- Coolant level
- Engine area (belts, hoses, leaks)
- Lights & Turn Signals (front, rear, brake, indicators)
- Mirrors & Windshield
- Fire extinguisher & Safety equipment
- Air lines & Connections
- Brakes (visual condition)
- Trailer inspection (if applicable)

PTI must be completed every day for your safety and for DOT compliance.
⚠️ Drivers who fail to complete PTI will be fined $100.`,

  ru: `Ежедневное напоминание о PTI

Здравствуйте, водитель.
Пожалуйста, выполните ваш ежедневный PTI. Убедитесь, что вы записали чёткое видео следующих пунктов:

- Приборная панель (нет предупреждающих индикаторов)
- Давление в шинах (PSI)
- Уровень охлаждающей жидкости (coolant)
- Двигатель (ремни, шланги, утечки)
- Фары и поворотники
- Зеркала и лобовое стекло
- Огнетушитель и аварийное оборудование
- Воздушные линии и соединения
- Тормоза (визуальное состояние)
- Осмотр прицепа (если есть)

PTI — обязательное требование DOT.
⚠️ Водители, которые не выполняют PTI, будут оштрафованы на $100.`,

  uz: `Har kunlik PTI eslatmasi

Assalomu alaykum, haydovchi.
Iltimos, har kungi PTI ni bajaring. Quyidagi qismlarning aniq video yozuvini taqdim eting:

- Panel (Dashboard)
- Shinalar bosimi (PSI)
- Coolant darajasi
- Dvigatel qismi
- Chiroqlar va burilish signallari
- Ko‘zgular va old oyna
- O‘t o‘chiruvchi vosita
- Havo liniyalari
- Tormozlar
- Tirkama (agar mavjud bo‘lsa)

PTI har kuni bajarilishi kerak.
⚠️ PTI qilinmasa — $100 jarima.`
} as const;

// тип языка берём из ключей объекта
export type LanguageCode = keyof typeof ptiMessages;
