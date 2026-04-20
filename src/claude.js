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
    {"name": "Название", "qty": 2, "unitPrice": 150.00, "total": 300.00}
  ],
  "surcharge": 0,
  "total": 0
}

ВАЖНО — qty:
- В чеке обычно есть колонка с количеством (кол-во, шт, qty) — найди её и используй
- Если позиция встречается несколько раз — суммируй в одну с нужным qty
- Если количество нигде не указано — ставь 1
- qty всегда целое число >= 1

Остальные правила:
- unitPrice — цена за 1 штуку (если не указана — total/qty)
- total — итоговая сумма строки (qty * unitPrice)
- surcharge — сервисный сбор, чаевые, обслуживание если есть (иначе 0)
- total в корне — итог всего чека (0 если не видно)
- все числа — числа, не строки
- items — только еда и напитки, без сервисных сборов`,
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
        qty,
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
