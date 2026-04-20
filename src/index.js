import { Telegraf, Markup } from 'telegraf'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { parseReceiptImage, parseAssignments, buildItems } from './claude.js'
import { calculate, formatResult } from './calculator.js'
import { persistentSession } from './session-store.js'

const agent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined
const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { agent } })

bot.use(persistentSession())

// ─── /start ──────────────────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  '👋 <b>SplitBot</b> — делим счёт честно\n\n' +
  'Отправь /new чтобы начать новый чек',
  { parse_mode: 'HTML' }
))

// ─── /new — начать сессию ─────────────────────────────────────────────────────

bot.command('new', ctx => {
  ctx.session = {}
  ctx.session.step = 'await_photo'
  return ctx.reply(
    '📸 Отправь фото чека\n\n<i>Или напиши /manual чтобы ввести позиции вручную</i>',
    { parse_mode: 'HTML' }
  )
})

// ─── /manual — ручной ввод ───────────────────────────────────────────────────

bot.command('manual', ctx => {
  ctx.session = {}
  ctx.session.step = 'await_manual'
  return ctx.reply(
    '📝 Введи позиции чека в формате:\n\n' +
    '<code>Бургер 350\nПиво 200\nСалат 280\nСервисный сбор 83</code>\n\n' +
    'Каждая позиция с новой строки: название и цена через пробел.\n' +
    'Строку с сервисным сбором/чаевыми подпиши: <code>сервисный сбор</code> или <code>чаевые</code>',
    { parse_mode: 'HTML' }
  )
})

// ─── /cancel ─────────────────────────────────────────────────────────────────

bot.command('cancel', ctx => {
  ctx.session = {}
  return ctx.reply('❌ Сессия сброшена. Отправь /new чтобы начать заново.')
})

// ─── Фото чека ───────────────────────────────────────────────────────────────

bot.on('photo', async ctx => {
  if (ctx.session?.step !== 'await_photo') {
    return ctx.reply('Отправь /new чтобы начать новый чек.')
  }

  const statusMsg = await ctx.reply('🔍 Распознаю чек...')

  try {
    // Берём фото максимального размера
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const fileLink = await ctx.telegram.getFileLink(largest.file_id)

    const res = await fetch(fileLink.href)
    const buffer = Buffer.from(await res.arrayBuffer())
    const base64 = buffer.toString('base64')

    const receipt = await parseReceiptImage(base64, 'image/jpeg')

    if (!receipt.items?.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        '❌ Не удалось распознать позиции. Попробуй сфотографировать чётче или введи /manual'
      )
      return
    }

    ctx.session.receipt = receipt
    ctx.session.step = 'await_confirm'

    const itemsList = receipt.items.map((i, n) =>
      `${n + 1}. ${i.name} — <b>${i.price.toFixed(2)} ₽</b>`
    ).join('\n')

    const surchargeInfo = receipt.surcharge > 0
      ? `\n\n➕ Сервисный сбор/чаевые: <b>${receipt.surcharge.toFixed(2)} ₽</b>`
      : ''

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `✅ <b>Распознал ${receipt.items.length} позиций:</b>\n\n${itemsList}${surchargeInfo}\n\n` +
      'Всё верно? Нажми <b>Подтвердить</b> или отправь исправленный список как /manual',
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('✅ Подтвердить', 'confirm_receipt')],
          [Markup.button.callback('✏️ Ввести вручную', 'go_manual')],
        ]).reply_markup,
      }
    )
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${e.message}`
    )
  }
})

// ─── Подтверждение чека ───────────────────────────────────────────────────────

bot.action('confirm_receipt', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.step = 'await_assignments'
  await ctx.editMessageReplyMarkup(undefined)
  await ctx.reply(
    '👥 Теперь напиши кто что брал.\n\n' +
    'Можно в свободной форме, например:\n' +
    '<i>Иван взял бургер и пиво, Маша — салат, десерт делим поровну, Иван заплатил за всех</i>\n\n' +
    'Или через запятую:\n' +
    '<i>Иван: бургер, пиво; Маша: салат; Петя: суп</i>\n\n' +
    'Позиции которые не упомянешь — разделятся поровну между всеми.',
    { parse_mode: 'HTML' }
  )
})

bot.action('go_manual', async ctx => {
  await ctx.answerCbQuery()
  ctx.session = { step: 'await_manual' }
  await ctx.reply(
    '📝 Введи позиции:\n<code>Бургер 350\nПиво 200\nСалат 280</code>',
    { parse_mode: 'HTML' }
  )
})

// ─── Текстовые сообщения ──────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const step = ctx.session?.step
  const text = ctx.message.text.trim()

  // ── Ручной ввод позиций ──
  if (step === 'await_manual') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const items = []
    let surcharge = 0

    for (const line of lines) {
      const parts = line.split(/\s+/)
      const price = parseFloat(parts[parts.length - 1].replace(',', '.'))
      if (isNaN(price)) continue
      const name = parts.slice(0, -1).join(' ')
      if (!name) continue

      const isExtra = /сервисный|чаевые|сбор|service|tip/i.test(name)
      if (isExtra) {
        surcharge += price
      } else {
        items.push({ name, price })
      }
    }

    if (!items.length) {
      return ctx.reply('❌ Не распознал позиции. Формат: <code>Название цена</code>', { parse_mode: 'HTML' })
    }

    ctx.session.receipt = { items, surcharge, total: 0 }
    ctx.session.step = 'await_assignments'

    const itemsList = items.map((i, n) =>
      `${n + 1}. ${i.name} — <b>${i.price.toFixed(2)} ₽</b>`
    ).join('\n')
    const surchargeInfo = surcharge > 0 ? `\n\n➕ Сервисный сбор: <b>${surcharge.toFixed(2)} ₽</b>` : ''

    await ctx.reply(
      `📋 <b>Позиции (${items.length}):</b>\n\n${itemsList}${surchargeInfo}\n\n` +
      '👥 Теперь напиши кто что брал (или просто перечисли имена через запятую чтобы делить поровну):',
      { parse_mode: 'HTML' }
    )
    return
  }

  // ── Распределение ──
  if (step === 'await_assignments') {
    const receipt = ctx.session.receipt
    const statusMsg = await ctx.reply('🤖 Считаю...')

    try {
      const parsed = await parseAssignments(text, receipt.items)

      // Собираем всех участников
      const allPeople = [...new Set(parsed.assignments.map(a => a.person))]
      if (!allPeople.length) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          '❌ Не нашёл имён. Напиши, например: <i>Иван: бургер; Маша: салат</i>',
          { parse_mode: 'HTML' }
        )
        return
      }

      const items = buildItems(receipt.items, parsed.assignments, parsed.shared || [], allPeople)
      const result = calculate(items, receipt.surcharge || 0)
      const text_out = formatResult(result, parsed.payer)

      ctx.session.step = null

      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        text_out,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Новый чек', 'new_check')],
          ]).reply_markup,
        }
      )
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        `❌ Ошибка: ${e.message}`
      )
    }
    return
  }

  // ── Нет активной сессии ──
  return ctx.reply('Отправь /new чтобы начать разбивку чека.', { parse_mode: 'HTML' })
})

// ─── Кнопка "Новый чек" ───────────────────────────────────────────────────────

bot.action('new_check', async ctx => {
  await ctx.answerCbQuery()
  ctx.session = { step: 'await_photo' }
  await ctx.editMessageReplyMarkup(undefined)
  await ctx.reply('📸 Отправь фото нового чека\n\n<i>Или /manual для ручного ввода</i>', { parse_mode: 'HTML' })
})

// ─── Запуск ───────────────────────────────────────────────────────────────────

bot.launch()
console.log('✅ SplitBot запущен')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
