import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * Распознаёт чек с фото.
 * Возвращает: { items: [{name, qty, unitPrice, total}], surcharge: number, total: number }
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
    {"name": "Название", "qty": 1, "unitPrice": 123.00, "total": 123.00}
  ],
  "surcharge": 0,
  "total": 0
}

Правила:
- items — только блюда/напитки
- qty — количество (целое число, минимум 1)
- unitPrice — цена за единицу (если не указана в чеке — считай total/qty)
- total — итоговая сумма строки (qty * unitPrice)
- surcharge — сервисный сбор или чаевые если есть в чеке (иначе 0)
- total в корне — итоговая сумма всего чека (0 если не видно)
- все числа — не строки`,
          },
        ],
      },
    ],
  })

  const text = message.content[0].text.trim()
  try {
    const parsed = JSON.parse(text)
    // Нормализуем: убеждаемся что total = qty * unitPrice
    parsed.items = parsed.items.map(item => {
      const qty = item.qty || 1
      const total = item.total || item.unitPrice * qty || 0
      const unitPrice = item.unitPrice || (qty > 0 ? total / qty : total)
      return { name: item.name, qty, unitPrice: Math.round(unitPrice * 100) / 100, total: Math.round(total * 100) / 100 }
    })
    return parsed
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Не удалось распознать чек. Попробуй сфотографировать чётче.')
  }
}

/**
 * Парсит одну строку участника: "Иван: бургер, пиво x2"
 * Возвращает: { person, items: [string] }
 */
export async function parseOnePerson(userText, remainingItems) {
  const itemNames = remainingItems.map(i => i.name).join(', ')

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Нераспределённые позиции из чека: ${itemNames}

Пользователь написал: "${userText}"

Определи имя участника и какие позиции он брал.

Верни ТОЛЬКО валидный JSON (без markdown):
{
  "person": "Имя",
  "items": ["название позиции 1", "название позиции 2"]
}

Правила:
- Сопоставляй позиции по смыслу (не обязательно точное совпадение)
- items — только из списка нераспределённых позиций
- Если позиция не найдена в списке — не включай
- Имя сохраняй как написал пользователь`,
      },
    ],
  })

  const text = message.content[0].text.trim()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Не удалось распарсить. Попробуй в формате: Имя: позиция1, позиция2')
  }
}
