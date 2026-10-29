import { config } from './config.js'

// Calls the private /api/bot routes on the library backend (routes/bot.js).
export async function botApi(pathname, { method = 'GET', body } = {}) {
  if (!config.botApiKey) throw new Error('BOT_API_KEY not set')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.searchTimeoutMs)
  try {
    const res = await fetch(`${config.backendUrl}/api/bot${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'x-bot-key': config.botApiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`Bot API ${pathname} returned ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}
