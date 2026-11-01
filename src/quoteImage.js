import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

// Draws the morning verse / study tip as a square card, the way the app
// shows them: logo, label, the quote (shrunk to fit so the card stays
// square), the reference and @rcfmouaulibrary. Made in memory and sent;
// nothing is written to disk. Fonts are bundled in assets/fonts because the
// server may have none installed.

const SIZE = 1080
const font = (name) => fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url))
const SERIF = { file: font('PlayfairDisplay-Bold.ttf'), family: 'Playfair Display Bold' }
const SANS = { file: font('Inter-SemiBold.ttf'), family: 'Inter SemiBold' }
const SANS_BOLD = { file: font('Inter-Bold.ttf'), family: 'Inter Bold' }
export const HANDLE = '@rcfmouaulibrary'

const THEMES = {
  verse: { bg: '#16235e', glow: '#2c3f9c', text: '#ffffff', soft: '#ffffffb3', faint: '#ffffff73', logoRing: '#ffffff' },
  tip: { bg: '#ffffff', glow: '#eef1fb', text: '#27272a', soft: '#16235e', faint: '#16235e80', logoRing: '#16235e' },
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// One block of text as a transparent PNG. size is in pixels.
async function text(str, { face, size, color, width, spacing = 0 }) {
  const markup = `<span foreground="${color}"${spacing ? ` letter_spacing="${Math.round(spacing * 1024)}"` : ''}>${escape(str)}</span>`
  const buf = await sharp({
    text: { text: markup, fontfile: face.file, font: `${face.family} ${size}`, width, align: 'centre', rgba: true, wrap: 'word', dpi: 72 },
  })
    .png()
    .toBuffer()
  const { width: w, height: h } = await sharp(buf).metadata()
  return { buf, w, h }
}

// The app's round logo, fetched each time (no local copy). Skipped if offline.
async function logo(ring) {
  try {
    const res = await fetch(`${config.siteUrl}/android-chrome-192x192.png`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const d = 132
    const mask = Buffer.from(`<svg width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}"/></svg>`)
    const round = await sharp(Buffer.from(await res.arrayBuffer())).resize(d, d).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
    const outer = d + 12
    const ringSvg = Buffer.from(`<svg width="${outer}" height="${outer}"><circle cx="${outer / 2}" cy="${outer / 2}" r="${outer / 2}" fill="${ring}" fill-opacity="0.35"/></svg>`)
    return { buf: await sharp(ringSvg).composite([{ input: round, left: 6, top: 6 }]).png().toBuffer(), w: outer, h: outer }
  } catch {
    return null
  }
}

// kind: 'verse' | 'tip'. Returns a PNG buffer.
export async function quoteCard({ kind, label, quote, by }) {
  const t = THEMES[kind] || THEMES.verse
  const background = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${t.bg}"/>
      <circle cx="${SIZE * 0.92}" cy="${SIZE * 0.06}" r="300" fill="${t.glow}" fill-opacity="0.55"/>
      <circle cx="${SIZE * 0.05}" cy="${SIZE * 0.97}" r="240" fill="${t.glow}" fill-opacity="0.45"/>
    </svg>`
  )

  const layers = []
  const center = (img, top) => layers.push({ input: img.buf, left: Math.round((SIZE - img.w) / 2), top: Math.round(top) })

  const mark = await logo(t.logoRing)
  if (mark) center(mark, 84)
  const labelImg = await text(label.toUpperCase(), { face: SANS, size: 28, color: t.faint, width: 900, spacing: 6 })
  center(labelImg, 256)

  // The quote shrinks until quote + reference fit between the label and the footer.
  const regionTop = 320
  const regionBottom = 940
  const byImg = by ? await text(`— ${by.toUpperCase()}`, { face: SANS_BOLD, size: 32, color: t.soft, width: 900, spacing: 3 }) : null
  const gap = byImg ? 44 : 0
  let quoteImg
  for (let size = 66; size >= 30; size -= 4) {
    quoteImg = await text(quote, { face: SERIF, size, color: t.text, width: 880 })
    if (quoteImg.h + gap + (byImg?.h || 0) <= regionBottom - regionTop) break
  }
  const block = quoteImg.h + gap + (byImg?.h || 0)
  const top = regionTop + (regionBottom - regionTop - block) / 2
  center(quoteImg, top)
  if (byImg) center(byImg, top + quoteImg.h + gap)

  const footer = await text(`${HANDLE}  ·  ${config.siteUrl.replace(/^https?:\/\//, '')}`, { face: SANS, size: 24, color: t.faint, width: 1000 })
  center(footer, SIZE - 74 - footer.h / 2)

  return sharp(background).composite(layers).png().toBuffer()
}
