/**
 * Рассчитывает итоговые долги между участниками.
 *
 * @param {Array}  items    — позиции чека: [{ name, price, participants: ['Иван','Маша'] }]
 * @param {number} surcharge — доп. сумма сверху (сервисный сбор, чаевые) или 0
 * @returns {{ totals: Object, debts: Array, grandTotal: number }}
 */
export function calculate(items, surcharge = 0) {
  // 1. Считаем сколько каждый должен по позициям
  const totals = {}

  for (const item of items) {
    const share = item.price / item.participants.length
    for (const person of item.participants) {
      totals[person] = (totals[person] || 0) + share
    }
  }

  // 2. Пропорционально добавляем сервисный сбор
  const baseTotal = Object.values(totals).reduce((s, v) => s + v, 0)
  if (surcharge > 0 && baseTotal > 0) {
    for (const person of Object.keys(totals)) {
      totals[person] += surcharge * (totals[person] / baseTotal)
    }
  }

  // 3. Округляем до 2 знаков
  for (const person of Object.keys(totals)) {
    totals[person] = Math.round(totals[person] * 100) / 100
  }

  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0)

  return { totals, grandTotal: Math.round(grandTotal * 100) / 100 }
}

/**
 * Форматирует итог для Telegram (HTML).
 * payer — кто уже оплатил весь чек (опционально).
 */
export function formatResult({ totals, grandTotal }, payer = null) {
  const lines = ['💳 <b>Итог разбивки:</b>\n']

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1])
  for (const [person, amount] of sorted) {
    const marker = payer && person === payer ? ' ✅ <i>(оплатил)</i>' : ''
    lines.push(`👤 ${person}: <b>${amount.toFixed(2)} ₽</b>${marker}`)
  }

  lines.push(`\n🧾 <b>Итого: ${grandTotal.toFixed(2)} ₽</b>`)

  if (payer && totals[payer] !== undefined) {
    lines.push('\n<b>Кто кому должен:</b>')
    for (const [person, amount] of sorted) {
      if (person !== payer) {
        const debt = Math.round((amount) * 100) / 100
        lines.push(`  └ ${person} → ${payer}: <b>${debt.toFixed(2)} ₽</b>`)
      }
    }
  }

  return lines.join('\n')
}
