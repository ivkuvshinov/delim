/**
 * Добавляет позиции участника к его итогу.
 * assignments: { person -> [itemName] }
 * items: [{ name, qty, unitPrice, total }]
 * unassigned: позиции не назначенные никому
 */
export function buildTotals(items, assignments, unassignedMode, allPeople) {
  const totals = {}

  // Инициализируем всех участников
  for (const person of allPeople) totals[person] = 0

  // Назначенные позиции
  for (const [person, itemNames] of Object.entries(assignments)) {
    for (const itemName of itemNames) {
      const item = items.find(i => i.name === itemName)
      if (item) totals[person] = (totals[person] || 0) + item.total
    }
  }

  // Нераспределённые позиции
  const assignedNames = Object.values(assignments).flat()
  const unassigned = items.filter(i => !assignedNames.includes(i.name))
  const unassignedSum = unassigned.reduce((s, i) => s + i.total, 0)

  if (unassignedSum > 0 && allPeople.length > 0) {
    if (unassignedMode === 'equal') {
      // Поровну по количеству людей
      const share = unassignedSum / allPeople.length
      for (const person of allPeople) totals[person] = (totals[person] || 0) + share
    } else {
      // Пропорционально текущей сумме каждого
      const assignedTotal = Object.values(totals).reduce((s, v) => s + v, 0)
      if (assignedTotal > 0) {
        for (const person of allPeople) {
          totals[person] = (totals[person] || 0) + unassignedSum * ((totals[person] || 0) / assignedTotal)
        }
      } else {
        // Если у всех 0 — делим поровну
        const share = unassignedSum / allPeople.length
        for (const person of allPeople) totals[person] = (totals[person] || 0) + share
      }
    }
  }

  // Округляем
  for (const person of Object.keys(totals)) {
    totals[person] = Math.round(totals[person] * 100) / 100
  }

  return totals
}

/**
 * Добавляет чаевые пропорционально доле каждого.
 */
export function addTips(totals, tipsAmount) {
  const base = Object.values(totals).reduce((s, v) => s + v, 0)
  const result = { ...totals }
  if (base > 0) {
    for (const person of Object.keys(result)) {
      result[person] = Math.round((result[person] + tipsAmount * (result[person] / base)) * 100) / 100
    }
  }
  return result
}

/**
 * Форматирует итог для Telegram (HTML).
 * payer — кто уже оплатил весь чек (опционально).
 */
export function formatResult(totals, payer = null) {
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0)
  const lines = ['💳 <b>Итог:</b>\n']

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1])
  for (const [person, amount] of sorted) {
    const marker = payer && person === payer ? ' ✅ <i>(оплатил)</i>' : ''
    lines.push(`👤 ${person}: <b>${amount.toFixed(2)} ₽</b>${marker}`)
  }

  lines.push(`\n🧾 <b>Итого: ${Math.round(grandTotal * 100) / 100} ₽</b>`)

  if (payer && totals[payer] !== undefined) {
    lines.push('\n<b>Долги:</b>')
    for (const [person, amount] of sorted) {
      if (person !== payer) {
        lines.push(`  └ ${person} → ${payer}: <b>${amount.toFixed(2)} ₽</b>`)
      }
    }
  }

  return lines.join('\n')
}
