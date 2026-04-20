import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * Распознаёт чек с фото.
 * Возвращает: { items: [{name, price}], surcharge: number, total: number }
 */
export async function parseReceiptImage(base64Image, mediaType = 'image/jpeg') {
  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image },
          },
          {
            type: 'text',
            text: `Распознай этот чек. Верни ТОЛЬКО валидный JSON (без markdown, без пояснений):
{
  "items": [
    {"name": "Название позиции", "price": 123.00}
  ],
  "surcharge": 0,
  "total": 0
}

Правила:
- items — только блюда/напитки с ценами
- surcharge — сервисный сбор или чаевые если есть в чеке (иначе 0)
- total — итоговая сумма чека (0 если не видно)
- price — числа, не строки
- Названия позиций сохраняй как в чеке`,
          },
        ],
      },
    ],
  })

  const text = message.content[0].text.trim()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Не удалось распознать чек. Попробуй сфотографировать чётче.')
  }
}

/**
 * Парсит свободный текст — кто что брал.
 * Возвращает: { assignments: [{person, items: [string]}], payer: string|null }
 */
export async function parseAssignments(userText, receiptItems) {
  const itemNames = receiptItems.map(i => i.name).join(', ')

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `Позиции из чека: ${itemNames}

Пользователь написал: "${userText}"

Задача: определить кто что брал и кто оплатил весь чек (если указано).

Верни ТОЛЬКО валидный JSON (без markdown):
{
  "assignments": [
    {"person": "Имя", "items": ["название позиции 1", "название позиции 2"]}
  ],
  "shared": ["название общей позиции"],
  "payer": "Имя или null"
}

Правила:
- Сопоставляй позиции из чека по смыслу (не обязательно точное совпадение)
- shared — позиции которые делятся поровну между всеми
- Если позиция не упомянута — добавь в shared
- payer — кто уже оплатил весь чек (фраза типа "Иван заплатил", "платил я" и т.д.)
- Имена сохраняй как написал пользователь`,
      },
    ],
  })

  const text = message.content[0].text.trim()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Не удалось распарсить распределение. Попробуй переформулировать.')
  }
}

/**
 * Склеивает assignments + shared → items с participants для калькулятора.
 */
export function buildItems(receiptItems, assignments, sharedItems, allPeople) {
  const result = []

  for (const item of receiptItems) {
    // Ищем кому назначена позиция
    const owners = []

    for (const a of assignments) {
      const match = a.items.some(i =>
        i.toLowerCase().includes(item.name.toLowerCase()) ||
        item.name.toLowerCase().includes(i.toLowerCase())
      )
      if (match) owners.push(a.person)
    }

    // Если в shared или никому не назначена — делим между всеми
    const isShared = sharedItems.some(s =>
      s.toLowerCase().includes(item.name.toLowerCase()) ||
      item.name.toLowerCase().includes(s.toLowerCase())
    )

    const participants = (owners.length > 0 && !isShared) ? owners : allPeople

    result.push({ ...item, participants })
  }

  return result
}
