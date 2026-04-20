import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = process.env.SESSION_FILE || resolve(__dir, '..', 'sessions.json')

mkdirSync(dirname(SESSION_FILE), { recursive: true })

function load() {
  if (!existsSync(SESSION_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function save(data) {
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8')
}

export function getSession(userId) {
  const all = load()
  return all[String(userId)] || {}
}

export function setSession(userId, session) {
  const all = load()
  all[String(userId)] = session
  save(all)
}

export function clearSession(userId) {
  const all = load()
  delete all[String(userId)]
  save(all)
}

export function persistentSession() {
  return async (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId) return next()

    ctx.session = getSession(userId)
    await next()
    setSession(userId, ctx.session || {})
  }
}
