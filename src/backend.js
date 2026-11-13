import { config } from './config.js'

// Sends files to /api/bot/uploads. files: [{ buffer, mimetype, fileName }].
export async function botUpload(fields, files) {
  if (!config.botApiKey) throw new Error('BOT_API_KEY not set')
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) if (value != null && value !== '') form.append(key, String(value))
  for (const f of files) form.append('files', new Blob([f.buffer], { type: f.mimetype }), f.fileName || 'file')
  const res = await fetch(`${config.backendUrl}/api/bot/uploads`, {
    method: 'POST',
    headers: { 'x-bot-key': config.botApiKey },
    body: form,
    signal: AbortSignal.timeout(180000), // Drive upload + AI read of the file
  })
  if (!res.ok) throw new Error(`Bot upload returned ${res.status}`)
  return res.json()
}

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
