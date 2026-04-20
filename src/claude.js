import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
            text: `Внимательно изучи фото чека. Верни ТОЛЬКО валидный JSON (без markdown, без пояснений):
{
  "items": [
    {"name": "Название", "qty": 2.5, "unitPrice": 150.00, "total": 375.00}
  ],
  "surcharge": 0,
  "total": 0
}

ВАЖНО — как читать строку чека:
Каждая строка чека обычно содержит: название | количество | цена за единицу | итоговая сумма
- qty = количество (может быть дробным: 2.5, 0.5 и т.д. — например для весового товара или порций)
- unitPrice = цена за единицу (одну штуку/порцию/100г)
- total = итоговая сумма строки = qty * unitPrice

Если в строке только одно число — это total, qty=1, unitPrice=total.
Если два числа — второе total, первое unitPrice, qty=1.
Если три числа — qty, unitPrice, total.

Дополнительные правила:
- surcharge — сервисный сбор, обслуживание, чаевые если есть (иначе 0)
- total в корне — итог всего чека (0 если не видно)
- items — только еда и напитки, без сервисных сборов
- все числа — числа, не строки`,
          },
        ],
      },
    ],
  })

  const text = message.content[0].text.trim()
  try {
    const parsed = JSON.parse(text)
    parsed.items = parsed.items.map(item => {
      const qty = item.qty || 1
      const total = item.total || item.unitPrice * qty || 0
      const unitPrice = item.unitPrice || (qty > 0 ? total / qty : total)
      return {
        name: item.name,
        qty: Math.round(qty * 100) / 100,
        unitPrice: Math.round(unitPrice * 100) / 100,
        total: Math.round(total * 100) / 100,
      }
    })
    return parsed
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Не удалось распознать чек. Попробуй сфотографировать чётче.')
  }
}

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
