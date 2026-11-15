import { getState, setState } from './state.js'

// What Bro Paul knows about the people he chats with, like a person would
// remember: the name they told him, and how to address them (Sir / Ma /
// a title like Pastor or Dr) when they made that clear themselves. Kept in
// the saved bot state so it survives restarts.
//
// { name, address: 'sir' | 'ma' | '', title, askedAt, nameTurnDone, updatedAt }
// - askedAt: when he asked their name (first chat).
// - nameTurnDone: their reply to that question has been handled, so he
//   never asks again, even if they didn't say it.
const KEY = 'contacts'
const MAX = 5000
const MAX_NOTES = 15 // things they told him about themselves: { text, at }

export function getContact(jid) {
  return getState(KEY, {})[jid] || null
}

export function updateContact(jid, patch) {
  if (!jid) return
  const all = getState(KEY, {})
  const next = { ...(all[jid] || {}), ...patch, updatedAt: Date.now() }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  all[jid] = next
  const ids = Object.keys(all)
  if (ids.length > MAX) {
    ids.sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0))
    for (const id of ids.slice(0, ids.length - MAX)) delete all[id]
  }
  setState(KEY, all)
}

// Only what the person themselves made clear; anything else is ignored.
export function learnFromReply(jid, member) {
  if (!member) return
  const patch = {}
  const name = String(member.name || '').replace(/[^\p{L}\p{M}' .-]/gu, '').trim().slice(0, 40)
  if (name.length >= 2) patch.name = name
  if (member.address === 'sir' || member.address === 'ma') patch.address = member.address
  const title = String(member.title || '').replace(/[^\p{L} .]/gu, '').trim().slice(0, 20)
  if (title) patch.title = title
  const fresh = (member.notes || []).map((n) => String(n).replace(/\s+/g, ' ').trim().slice(0, 120)).filter((n) => n.length >= 3)
  if (fresh.length) {
    const old = getContact(jid)?.notes || []
    const seen = new Set(old.map((n) => n.text.toLowerCase()))
    const added = fresh.filter((n) => !seen.has(n.toLowerCase())).map((text) => ({ text, at: Date.now() }))
    if (added.length) patch.notes = [...old, ...added].slice(-MAX_NOTES)
  }
  if (Object.keys(patch).length) updateContact(jid, patch)
}

// Phone number from a WhatsApp id ("2348012345678@s.whatsapp.net"), or ''
// for ids that hide the number (groups, @lid).
export function phoneOf(jid) {
  const m = String(jid).match(/^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/)
  return m ? `+${m[1]}` : ''
}
