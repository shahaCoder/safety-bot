# Путь fetch для Severe Speeding Events

## 1. API Endpoint

**URL:** `https://api.samsara.com/speeding-intervals/stream`

**Метод:** `GET`

**Параметры запроса:**
- `startTime` - ISO строка (например: `2025-12-16T19:00:00.000Z`)
- `endTime` - ISO строка (например: `2025-12-16T22:00:00.000Z`)
- `assetIds` - массив ID траков (может быть несколько параметров с одинаковым именем)
- `cursor` - для пагинации (опционально)

**Пример запроса:**
```
GET https://api.samsara.com/speeding-intervals/stream?startTime=2025-12-16T19:00:00.000Z&endTime=2025-12-16T22:00:00.000Z&assetIds=281474995523174
```

## 2. Как формируется startTime и endTime

### В команде `/severe_speeding_test`:

```typescript
// Файл: src/index.ts, строка ~1239

const now = new Date();  // Текущее время
const from = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 часа назад

// Передается в fetchSpeedingIntervals
const result = await fetchSpeedingIntervals({ 
  from,  // Date объект
  to: now  // Date объект
});
```

### В функции `fetchSpeedingIntervals`:

```typescript
// Файл: src/services/samsaraSpeeding.ts, строка ~245

// Date объекты конвертируются в ISO строки
const baseWindow: Window = {
  startTime: opts.from.toISOString(),  // "2025-12-16T19:00:00.000Z"
  endTime: opts.to.toISOString(),      // "2025-12-16T22:00:00.000Z"
};
```

### Window Expansion (расширение окна):

Если в базовом окне нет данных, функция автоматически расширяет окно:

```typescript
// Файл: src/services/samsaraSpeeding.ts, строка ~250

const expansionStrategies = [
  { minutes: 120, label: '±120m' },   // ±2 часа
  { minutes: 360, label: '±360m' },   // ±6 часов
  { minutes: 720, label: '±720m' },   // ±12 часов
];

// Функция expandWindow расширяет окно в обе стороны
function expandWindow(isoStart: string, isoEnd: string, minutes: number): Window {
  const start = new Date(isoStart);
  const end = new Date(isoEnd);
  
  // Расширяем на ±minutes
  const expandedStart = new Date(start.getTime() - minutes * 60 * 1000);
  const expandedEnd = new Date(end.getTime() + minutes * 60 * 1000);
  
  return {
    startTime: expandedStart.toISOString(),
    endTime: expandedEnd.toISOString(),
  };
}
```

### В функции `fetchSpeedingIntervalsForWindow` (фактический запрос):

```typescript
// Файл: src/services/samsaraSpeeding.ts, строка ~94

const params = new URLSearchParams();
params.set('startTime', window.startTime);  // ISO строка
params.set('endTime', window.endTime);      // ISO строка

// Добавляем assetIds (может быть несколько)
for (const assetId of chunk) {
  params.append('assetIds', assetId);
}

// Финальный запрос
const url = `https://api.samsara.com/speeding-intervals/stream`;
const res = await axios.get(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  },
  params,  // startTime, endTime, assetIds
});
```

## 3. Пример для команды `/severe_speeding_test`

**Текущее время:** 16 декабря 2025, 2:58 PM (14:58)

```typescript
// 1. Формирование окна
const now = new Date();  // 2025-12-16T19:58:00.000Z (UTC)
const from = new Date(now.getTime() - 3 * 60 * 60 * 1000);  
// from = 2025-12-16T16:58:00.000Z (3 часа назад)

// 2. Конвертация в ISO строки
startTime = "2025-12-16T16:58:00.000Z"
endTime = "2025-12-16T19:58:00.000Z"

// 3. Если данных нет, расширяется окно:
// Попытка 1: ±120m
//   startTime = "2025-12-16T14:58:00.000Z" (16:58 - 2 часа)
//   endTime = "2025-12-16T21:58:00.000Z" (19:58 + 2 часа)

// Попытка 2: ±360m (если первая пустая)
//   startTime = "2025-12-16T10:58:00.000Z" (16:58 - 6 часов)
//   endTime = "2025-12-16T01:58:00.000Z" (19:58 + 6 часов, на следующий день)

// 4. Финальный запрос
GET https://api.samsara.com/speeding-intervals/stream
  ?startTime=2025-12-16T16:58:00.000Z
  &endTime=2025-12-16T19:58:00.000Z
  &assetIds=281474995523174
```

## 4. В cron (checkAndNotifySafetyEvents)

Используется `fetchSpeedingIntervalsWithSlidingWindow()`, которая:
- Использует окно 12 часов + буфер 10 минут
- Не расширяет окно (фиксированное)
- Фильтрует по порогу превышения скорости

```typescript
// Файл: src/services/samsaraSpeeding.ts, строка ~408

const windowHours = 12;
const bufferMinutes = 10;

const now = new Date();
const windowStart = new Date(now.getTime() - (windowHours * 60 + bufferMinutes) * 60 * 1000);
const windowEnd = new Date(now.getTime() + 1 * 60 * 1000); // +1 минута

// startTime = now - 12h10m
// endTime = now + 1m
```

## 5. Формат времени

Все времена в **UTC (ISO 8601)**:
- Формат: `YYYY-MM-DDTHH:mm:ss.sssZ`
- Пример: `2025-12-16T19:58:00.000Z`
- `Z` означает UTC (время по Гринвичу)

## 6. Важные моменты

1. **Window Expansion** работает только в `fetchSpeedingIntervals()`, не в `fetchSpeedingIntervalsWithSlidingWindow()`
2. **Chunking**: Если траков больше 200, они разбиваются на чанки
3. **Pagination**: API может вернуть курсор для следующей страницы
4. **Timezone**: Все времена в UTC, конвертация в локальное время происходит при отображении

