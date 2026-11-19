// One-off: send the "Upgrade in progress" image to Bro Paul's active groups
// while his Render service is suspended. Uses his saved login (database).
// DRY_RUN=1 connects and lists the groups without sending anything.
import dotenv from 'dotenv'
import fs from 'node:fs'
import pino from 'pino'
import pg from 'pg'
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys'

dotenv.config({ path: '../rcf-library-backend/.env' })
const { loadAuth } = await import('./src/authStore.js')

const DRY = process.env.DRY_RUN === '1'
const IMAGE = process.env.IMAGE
const SKIP = ['Ai grpup test']
// Already received it in the first run (stopped early by the time limit).
const ALREADY_SENT = [
  '🔥DTCE SOUTH EAST COMMUNITY (ZONE4)🔥', 'ABIA 5 TEENAGERS', 'BROTHERS FORUM RCF', 'CRM ABIA ZONE COMMUNITY',
  'DTCE SOUTH EAST TEENS AFFAIRS PLATFORM', "GOD'S YOUNG DIPLOMATS ", 'MOUAU INFO GROUP', 'MOUAU RCF FRESHERS UPDATE',
]
const CAPTION = `📢 *Quick update from the RCF MOUAU Library* 📚

Hello family! 👋 Our library app is taking a short break while we upgrade it to something *faster and better* 🚀

✅ Your account, saved books and downloads are safe. Nothing is lost.
⏳ We'll be back very soon, and I'll tell you here the moment we're live again.

I'll be resting during the upgrade too, so I may not reply for a while 😅

Thank you for your patience 🙏
— Bro Paul, for the RCF MOUAU Library Team`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await db.connect()
const rows = (
  await db.query(`SELECT jid, name FROM whatsapp_groups
    WHERE enabled = true AND coalesce((settings->>'left')::boolean, false) = false
      AND coalesce((settings->>'started')::boolean, true) = true ORDER BY name`)
).rows.filter((r) => !SKIP.includes(r.name) && !ALREADY_SENT.includes(r.name))
await db.end()

const image = DRY ? null : fs.readFileSync(IMAGE)
const auth = await loadAuth()
const sock = makeWASocket({ auth: auth.state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false })
sock.ev.on('creds.update', auth.saveCreds)

const finish = async (code) => {
  await sleep(4000) // let saved keys reach the database
  sock.end(undefined)
  setTimeout(() => process.exit(code), 1000)
}
setTimeout(() => { console.log('Timed out'); finish(1) }, 25 * 60 * 1000)

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr) { console.log('WhatsApp wants a new QR scan: stopping (the saved login is not valid here).'); return finish(1) }
  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode
    console.log(`Connection closed (code ${code})${code === DisconnectReason.loggedOut ? ' LOGGED OUT' : ''}`)
    return
  }
  if (connection !== 'open') return
  console.log(`Connected as Bro Paul (${String(sock.user?.id).split(':')[0]})`)
  const joined = await sock.groupFetchAllParticipating()
  const targets = rows.filter((r) => joined[r.jid])
  for (const r of rows) if (!joined[r.jid]) console.log(`  not a member any more, skipped: ${r.name}`)
  console.log(`${targets.length} groups${DRY ? ' (dry run, nothing sent)' : ''}:`)
  let sent = 0
  for (const r of targets) {
    if (DRY) { console.log(`  - ${r.name}`); continue }
    try {
      await sock.sendMessage(r.jid, { image, caption: CAPTION, mimetype: 'image/png' })
      sent += 1
      console.log(`  ✓ ${r.name}`)
    } catch (err) {
      console.log(`  ✗ ${r.name}: ${err.message}`)
    }
    await sleep(5000 + Math.random() * 4000) // spaced out, like a person
  }
  if (!DRY) console.log(`Sent to ${sent} of ${targets.length} groups.`)
  finish(0)
})
