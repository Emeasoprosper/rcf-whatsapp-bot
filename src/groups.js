import { config } from './config.js'
import { botApi } from './backend.js'

// Which groups the bot talks in:
// - With BOT_API_KEY: the groups switched on in the admin app's WhatsApp Bot
//   page. A group the bot is added to is reported to the backend, which turns
//   it on automatically and notifies the superadmins. ALLOWED_GROUP_JID is
//   only used until the first list arrives from the backend.
// - Without it: only ALLOWED_GROUP_JID from .env.
const backendOn = () => Boolean(config.botApiKey)
let groups = new Set(config.allowedGroups)
let settingsByGroup = {}
const reported = new Set()

// Set per group on the admin app's WhatsApp Bot page.
// audience: 'campus' (MOUAU students), 'mixed' or 'general' (not students).
const DEFAULT_GROUP_SETTINGS = {
  audience: 'campus',
  bookOfDay: true,
  morningPost: true,
  promos: true,
  welcome: true,
  chimeIn: true,
  newMonth: true,
  birthdays: true,
}

export function groupSettings(jid) {
  return { ...DEFAULT_GROUP_SETTINGS, ...(settingsByGroup[jid] || {}) }
}

// The groups where a kind of post is switched on, e.g. allowedGroupsFor('bookOfDay').
export function allowedGroupsFor(key) {
  return allowedGroups().filter((jid) => groupSettings(jid)[key] !== false)
}

export function isAllowedGroup(jid) {
  return groups.has(jid)
}

export function allowedGroups() {
  return [...groups]
}

export async function refreshGroups() {
  if (!backendOn()) return
  try {
    const { jids = [], settings = {} } = await botApi('/groups')
    groups = new Set(jids)
    settingsByGroup = settings
  } catch (err) {
    console.error('Could not refresh group list:', err.message)
  }
}

// Called once for a group the bot has never been in before (so it can
// introduce itself). Set from index.js.
let newGroupHandler = null
export function whenNewGroup(fn) {
  newGroupHandler = fn
}

// sock is used to look up the group's name. Safe to call often: each group
// is only reported once per run.
export async function reportGroup(sock, jid, meta = null) {
  if (!backendOn() || !jid?.endsWith('@g.us') || reported.has(jid)) return
  reported.add(jid)
  try {
    const info = meta || (await sock.groupMetadata(jid).catch(() => null))
    const { enabled, isNew } = await botApi('/groups', {
      method: 'POST',
      body: { jid, name: info?.subject || null, memberCount: info?.participants?.length ?? null },
    })
    if (enabled) groups.add(jid)
    else groups.delete(jid)
    if (isNew) console.log(`[groups] New group "${info?.subject || jid}" registered${enabled ? ' and switched on' : ''}`)
    if (isNew && enabled && newGroupHandler) newGroupHandler(jid)
  } catch (err) {
    // Try again in 10 minutes, not on every message (backend may be asleep).
    setTimeout(() => reported.delete(jid), 10 * 60 * 1000)
    console.error(`Could not report group ${jid}:`, err.message)
  }
}

export async function reportAllGroups(sock) {
  if (!backendOn()) return
  try {
    const all = await sock.groupFetchAllParticipating()
    for (const [jid, meta] of Object.entries(all)) await reportGroup(sock, jid, meta)
  } catch (err) {
    console.error('Could not list groups:', err.message)
  }
}
