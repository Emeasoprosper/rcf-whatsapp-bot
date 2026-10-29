import fs from 'node:fs'
import pg from 'pg'
import { initAuthCreds, BufferJSON, proto, useMultiFileAuthState } from '@whiskeysockets/baileys'

// Where the bot keeps its WhatsApp login.
// - DATABASE_URL set (server / Render): in the library database, so the login
//   survives restarts and redeploys. Same table the backend migration makes.
// - Not set (your PC): the auth_info_baileys folder, like before.
const AUTH_DIR = 'auth_info_baileys'

let pool = null

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 3,
    })
  }
  return pool
}

async function usePgAuthState() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  const write = (key, data) =>
    db.query(
      `INSERT INTO whatsapp_auth (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(data, BufferJSON.replacer)]
    )

  const saved = await db.query(`SELECT value FROM whatsapp_auth WHERE key = 'creds'`)
  const creds = saved.rows[0] ? JSON.parse(saved.rows[0].value, BufferJSON.reviver) : initAuthCreds()

  const keys = {
    get: async (type, ids) => {
      const result = await db.query(`SELECT key, value FROM whatsapp_auth WHERE key = ANY($1)`, [ids.map((id) => `${type}-${id}`)])
      const byKey = new Map(result.rows.map((r) => [r.key, r.value]))
      const data = {}
      for (const id of ids) {
        const raw = byKey.get(`${type}-${id}`)
        let value = raw ? JSON.parse(raw, BufferJSON.reviver) : null
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
        data[id] = value
      }
      return data
    },
    set: async (data) => {
      const tasks = []
      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const value = data[category][id]
          const key = `${category}-${id}`
          tasks.push(value ? write(key, value) : db.query(`DELETE FROM whatsapp_auth WHERE key = $1`, [key]))
        }
      }
      await Promise.all(tasks)
    },
  }

  return {
    state: { creds, keys },
    saveCreds: () => write('creds', creds),
    // Keeps the bot's saved state row (state.js), only the login goes.
    clear: () => db.query(`DELETE FROM whatsapp_auth WHERE key <> 'bot-state'`),
    where: 'database',
  }
}

export async function loadAuth() {
  if (process.env.DATABASE_URL) return usePgAuthState()
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  return {
    state,
    saveCreds,
    clear: async () => fs.rmSync(AUTH_DIR, { recursive: true, force: true }),
    where: `${AUTH_DIR} folder`,
  }
}
