import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { parseReceiptImage, parseOnePerson } from './claude.js'
import { buildTotals, addTips, formatResult } from './calculator.js'
import { persistentSession } from './session-store.js'

const agent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined
const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { agent } })

bot.use(persistentSession())

// ─── Helpers ─────────────────────────────────────────────────────────────────

function remainingItems(session) {
  const assigned = Object.values(session.assignments || {}).flat()
  return (session.receipt?.items || []).filter(i => !assigned.includes(i.name))
}

function formatRemaining(items) {
  if (!items.length) return '✅ Все позиции распределены'
  return '📋 <b>Нераспределено:</b>\n' + items.map(i =>
    `• ${i.name}${i.qty !== 1 ? ` x${i.qty}` : ''} — <b>${i.total.toFixed(2)} ₽</b>${i.qty !== 1 ? ` (${i.unitPrice.toFixed(2)}₽/шт)` : ''}`
  ).join('\n')
}

function assignKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Готово, распределить остаток', 'assign_done')],
    [Markup.button.callback('❌ Отмена', 'cancel')],
  ])
}

// ─── /start ──────────────────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  '👋 <b>Delim</b> — делим счёт честно\n\nОтправь /new чтобы начать',
  { parse_mode: 'HTML' }
))

// ─── /new ─────────────────────────────────────────────────────────────────────

bot.command('new', ctx => {
  ctx.session = {}
  ctx.session.step = 'await_photo'
  return ctx.reply(
    '📸 Отправь фото чека\n\n<i>Или /manual для ручного ввода</i>',
    { parse_mode: 'HTML' }
  )
})

// ─── /manual ─────────────────────────────────────────────────────────────────

bot.command('manual', ctx => {
  ctx.session = {}
  ctx.session.step = 'await_manual'
  return ctx.reply(
    '📝 Введи позиции чека:\n\n<code>Бургер 350\nПиво 2 200\nСалат 280</code>\n\n' +
    'Формат: <code>Название [кол-во] сумма</code>\n' +
    'Если кол-во не указано — считается 1 шт.',
    { parse_mode: 'HTML' }
  )
})

// ─── /cancel ─────────────────────────────────────────────────────────────────

bot.command('cancel', ctx => {
  ctx.session = {}
  return ctx.reply('❌ Сброшено. /new — начать заново.')
})

bot.action('cancel', ctx => {
  ctx.session = {}
  ctx.answerCbQuery()
  return ctx.reply('❌ Сброшено. /new — начать заново.')
})

// ─── Фото чека ───────────────────────────────────────────────────────────────

bot.on('photo', async ctx => {
  if (ctx.session?.step !== 'await_photo') {
    return ctx.reply('Отправь /new чтобы начать.')
  }

  const statusMsg = await ctx.reply('🔍 Распознаю чек...')

  try {
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const fileLink = await ctx.telegram.getFileLink(largest.file_id)
    const res = await fetch(fileLink.href)
    const buffer = Buffer.from(await res.arrayBuffer())
    const base64 = buffer.toString('base64')

    const receipt = await parseReceiptImage(base64, 'image/jpeg')

    if (!receipt.items?.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        '❌ Не удалось распознать позиции. Попробуй чётче или /manual'
      )
      return
    }

    ctx.session.receipt = receipt
    ctx.session.assignments = {}
    ctx.session.people = []
    ctx.session.step = 'await_person'

    const itemsList = receipt.items.map(i =>
      `• ${i.name}${i.qty !== 1 ? ` x${i.qty}` : ''} — <b>${i.total.toFixed(2)} ₽</b>${i.qty !== 1 ? ` (${i.unitPrice.toFixed(2)}₽/шт)` : ''}`
    ).join('\n')

    const surchargeInfo = receipt.surcharge > 0
      ? `\n\n➕ Сервисный сбор: <b>${receipt.surcharge.toFixed(2)} ₽</b>`
      : ''

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `✅ <b>Распознал ${receipt.items.length} позиций:</b>\n\n${itemsList}${surchargeInfo}\n\n` +
      '👤 Напиши первого участника и что он брал:\n<i>Иван: бургер, пиво</i>',
      { parse_mode: 'HTML', ...assignKeyboard() }
    )
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${e.message}`
    )
  }
})

// ─── Кнопка "Готово" ──────────────────────────────────────────────────────────

bot.action('assign_done', async ctx => {
  await ctx.answerCbQuery()
  const remaining = remainingItems(ctx.session)

  if (!ctx.session.people?.length) {
    return ctx.reply('❌ Сначала добавь хотя бы одного участника.')
  }

  if (!remaining.length) {
    // Всё распределено — сразу к чаевым
    ctx.session.step = 'await_tips'
    return ctx.reply(
      '💰 Добавить чаевые?\n\nВведи сумму или % (например: <code>300</code> или <code>10%</code>)\nИли нажми "Пропустить"',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('Пропустить', 'skip_tips')]])
      }
    )
  }

  const remainingSum = remaining.reduce((s, i) => s + i.total, 0)
  const remainingList = remaining.map(i =>
    `• ${i.name}${i.qty !== 1 ? ` x${i.qty}` : ''} — ${i.total.toFixed(2)} ₽${i.qty !== 1 ? ` (${i.unitPrice.toFixed(2)}₽/шт)` : ''}`
  ).join('\n')

  ctx.session.step = 'await_unassigned_mode'
  await ctx.reply(
    `📋 <b>Нераспределено на ${remainingSum.toFixed(2)} ₽:</b>\n\n${remainingList}\n\nКак делим остаток?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👥 Поровну между всеми', 'unassigned_equal')],
        [Markup.button.callback('📊 Пропорционально сумме', 'unassigned_prop')],
      ])
    }
  )
})

// ─── Режим нераспределённого ──────────────────────────────────────────────────

bot.action('unassigned_equal', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.unassignedMode = 'equal'
  ctx.session.step = 'await_tips'
  await ctx.reply(
    '💰 Добавить чаевые?\n\nВведи сумму или % (например: <code>300</code> или <code>10%</code>)\nИли нажми "Пропустить"',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('Пропустить', 'skip_tips')]])
    }
  )
})

bot.action('unassigned_prop', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.unassignedMode = 'prop'
  ctx.session.step = 'await_tips'
  await ctx.reply(
    '💰 Добавить чаевые?\n\nВведи сумму или % (например: <code>300</code> или <code>10%</code>)\nИли нажми "Пропустить"',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('Пропустить', 'skip_tips')]])
    }
  )
})

// ─── Пропустить чаевые ────────────────────────────────────────────────────────

bot.action('skip_tips', async ctx => {
  await ctx.answerCbQuery()
  await showResult(ctx, 0)
})

// ─── Кто платил ───────────────────────────────────────────────────────────────

bot.action(/^payer_(.+)$/, async ctx => {
  const payer = ctx.match[1]
  await ctx.answerCbQuery()
  const totals = ctx.session.finalTotals
  if (!totals) return
  await ctx.editMessageText(formatResult(totals, payer), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Новый чек', 'new_check')]])
  })
})

bot.action('new_check', async ctx => {
  await ctx.answerCbQuery()
  ctx.session = { step: 'await_photo' }
  await ctx.reply('📸 Отправь фото нового чека\n\n<i>Или /manual</i>', { parse_mode: 'HTML' })
})

// ─── Показать итог ────────────────────────────────────────────────────────────

async function showResult(ctx, tipsAmount) {
  const { receipt, assignments, unassignedMode, people } = ctx.session
  const totals = buildTotals(receipt.items, assignments, unassignedMode || 'equal', people)

  // Добавляем сервисный сбор из чека пропорционально
  const withSurcharge = receipt.surcharge > 0 ? addTips(totals, receipt.surcharge) : totals
  const final = tipsAmount > 0 ? addTips(withSurcharge, tipsAmount) : withSurcharge

  ctx.session.finalTotals = final
  ctx.session.step = null

  const payerButtons = people.map(p => Markup.button.callback(p, `payer_${p}`))
  const rows = []
  for (let i = 0; i < payerButtons.length; i += 3) rows.push(payerButtons.slice(i, i + 3))
  rows.push([Markup.button.callback('🔄 Новый чек', 'new_check')])

  await ctx.reply(
    formatResult(final) + '\n\n<i>Кто оплатил весь счёт?</i>',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
  )
}

// ─── Текстовые сообщения ──────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const step = ctx.session?.step
  const text = ctx.message.text.trim()

  // ── Ручной ввод ──
  if (step === 'await_manual') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const items = []
    let surcharge = 0

    for (const line of lines) {
      const parts = line.split(/\s+/)
      // Последнее число — сумма, предпоследнее число (если есть) — кол-во
      const last = parseFloat(parts[parts.length - 1].replace(',', '.'))
      if (isNaN(last)) continue

      let qty = 1
      let nameEnd = parts.length - 1

      const secondLast = parseFloat(parts[parts.length - 2]?.replace(',', '.'))
      if (!isNaN(secondLast) && parts.length >= 3) {
        qty = Math.round(secondLast)
        nameEnd = parts.length - 2
      }

      const name = parts.slice(0, nameEnd).join(' ')
      if (!name) continue

      const total = last
      const unitPrice = Math.round((total / qty) * 100) / 100

      const isExtra = /сервисный|чаевые|сбор|service|tip/i.test(name)
      if (isExtra) {
        surcharge += total
      } else {
        items.push({ name, qty, unitPrice, total })
      }
    }

    if (!items.length) {
      return ctx.reply('❌ Не распознал позиции.\nФормат: <code>Название [кол-во] сумма</code>', { parse_mode: 'HTML' })
    }

    ctx.session.receipt = { items, surcharge, total: 0 }
    ctx.session.assignments = {}
    ctx.session.people = []
    ctx.session.step = 'await_person'

    const itemsList = items.map(i =>
      `• ${i.name}${i.qty !== 1 ? ` x${i.qty}` : ''} — <b>${i.total.toFixed(2)} ₽</b>${i.qty !== 1 ? ` (${i.unitPrice.toFixed(2)}₽/шт)` : ''}`
    ).join('\n')
    const surchargeInfo = surcharge > 0 ? `\n\n➕ Сервисный сбор: <b>${surcharge.toFixed(2)} ₽</b>` : ''

    return ctx.reply(
      `📋 <b>Позиций: ${items.length}</b>\n\n${itemsList}${surchargeInfo}\n\n` +
      '👤 Напиши первого участника и что он брал:\n<i>Иван: бургер, пиво</i>',
      { parse_mode: 'HTML', ...assignKeyboard() }
    )
  }

  // ── Участник ──
  if (step === 'await_person') {
    const remaining = remainingItems(ctx.session)
    if (!remaining.length) {
      return ctx.reply('✅ Все позиции уже распределены. Нажми "Готово".', assignKeyboard())
    }

    const statusMsg = await ctx.reply('🤖 Обрабатываю...')
    try {
      const parsed = await parseOnePerson(text, remaining)

      if (!parsed.person) throw new Error('Не нашёл имя участника')

      // Добавляем участника
      if (!ctx.session.people.includes(parsed.person)) {
        ctx.session.people.push(parsed.person)
      }

      // Записываем назначения
      ctx.session.assignments[parsed.person] = [
        ...(ctx.session.assignments[parsed.person] || []),
        ...parsed.items,
      ]

      const newRemaining = remainingItems(ctx.session)
      const assignedList = parsed.items.length
        ? parsed.items.map(i => `• ${i}`).join('\n')
        : '(ничего не назначено)'

      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        `✅ <b>${parsed.person}:</b>\n${assignedList}\n\n${formatRemaining(newRemaining)}\n\n` +
        (newRemaining.length ? '👤 Следующий участник? Или нажми "Готово"' : 'Нажми "Готово"'),
        { parse_mode: 'HTML', ...assignKeyboard() }
      )
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        `❌ ${e.message}`
      )
    }
    return
  }

  // ── Чаевые ──
  if (step === 'await_tips') {
    let tips = 0
    const receipt = ctx.session.receipt
    const baseTotal = receipt.items.reduce((s, i) => s + i.total, 0)

    if (text.endsWith('%')) {
      const pct = parseFloat(text)
      if (!isNaN(pct)) tips = Math.round(baseTotal * pct / 100 * 100) / 100
    } else {
      tips = parseFloat(text.replace(',', '.')) || 0
    }

    ctx.session.step = null
    await showResult(ctx, tips)
    return
  }

  return ctx.reply('Отправь /new чтобы начать.')
})

// ─── Запуск ───────────────────────────────────────────────────────────────────

bot.launch()
console.log('✅ Delim запущен')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
