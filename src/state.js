import { readFileSync, writeFileSync } from 'node:fs'
import { getPool } from './authStore.js'

// Small saved state so timers (like the last advert) survive a restart and
// the bot doesn't re-post the moment it starts again.
// - DATABASE_URL set (server): one row in whatsapp_auth, since hosts like
//   Render wipe local files on every restart.
// - Otherwise: bot-state.json next to the bot.
const STATE_FILE = 'bot-state.json'
const DB_KEY = 'bot-state'

let state = {}

export async function initState() {
  try {
    if (process.env.DATABASE_URL) {
      const db = getPool()
      await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_auth (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
      const result = await db.query(`SELECT value FROM whatsapp_auth WHERE key = $1`, [DB_KEY])
      state = result.rows[0] ? JSON.parse(result.rows[0].value) : {}
    } else {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    }
  } catch {
    state = {}
  }
}

export function getState(key, fallback) {
  return state[key] ?? fallback
}

export function setState(key, value) {
  state[key] = value
  const json = JSON.stringify(state, null, 2)
  if (process.env.DATABASE_URL) {
    getPool()
      .query(
        `INSERT INTO whatsapp_auth (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [DB_KEY, json]
      )
      .catch((err) => console.error('Could not save bot state:', err.message))
    return
  }
  try {
    writeFileSync(STATE_FILE, json)
  } catch (err) {
    console.error('Could not save bot-state.json:', err.message)
  }
}
