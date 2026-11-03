import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { config } from './config.js'

// Bro Paul's own voice notes: his reply is spoken by Gemini text-to-speech
// in a male voice (warm, Nigerian English accent) and turned into a WhatsApp
// voice note (OGG Opus). Used to answer voice notes with a voice note.
// Anything that fails returns null, and the caller sends text instead.

// Replies with links, contacts or lists are better read than heard.
const NOT_FOR_VOICE = /https?:\/\/|wa\.me\/|www\.|📞|\n\s*\d+\.\s|\n\s*[-•]\s/i
const MAX_VOICE_CHARS = 700

export function suitsVoice(text) {
  return Boolean(text) && text.length <= MAX_VOICE_CHARS && !NOT_FOR_VOICE.test(text)
}

// What gets spoken: no emojis, WhatsApp formatting or sticker tags.
function speakable(text) {
  return text
    .replace(/\[sticker:[^\]]*\]/gi, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const STYLE =
  'Read this WhatsApp voice reply aloud as a friendly young Nigerian man, warm and relaxed, with a natural Nigerian English accent ' +
  '(read any Pidgin naturally). Read only the message:\n\n'

// The speech model sometimes answers with no audio (or is briefly busy on
// the free tier), so it gets a few tries; the last one drops the style note.
const RETRYABLE = new Set([429, 500, 503])
const WAIT_MS = [4000, 20000]
let pausedUntil = 0

async function geminiSpeechOnce(text, styled) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.ttsModel}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: styled ? STYLE + text : text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.ttsVoice } } },
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // Daily allowance used up (free tier: about 10 voice notes a day):
    // stop asking until it resets, so text replies aren't held up.
    if (res.status === 429 && /PerDay/i.test(body)) {
      const secs = Number(/"retryDelay":\s*"(\d+)s"/.exec(body)?.[1]) || 6 * 3600
      pausedUntil = Date.now() + secs * 1000
      const err = new Error(`daily voice allowance used up; voice notes resume in about ${Math.ceil(secs / 3600)}h`)
      err.retry = false
      throw err
    }
    const err = new Error(`Gemini speech failed (${res.status}): ${body.replace(/\s+/g, ' ').slice(0, 150)}`)
    err.retry = RETRYABLE.has(res.status)
    throw err
  }
  const data = await res.json()
  const candidate = data.candidates?.[0]
  const audio = candidate?.content?.parts?.find((p) => p.inlineData)?.inlineData
  if (!audio?.data) {
    const why = candidate?.finishReason || data.promptFeedback?.blockReason || 'empty answer'
    const err = new Error(`Gemini speech returned no audio (${why})`)
    err.retry = true
    throw err
  }
  const rate = Number(/rate=(\d+)/.exec(audio.mimeType || '')?.[1]) || 24000
  return { pcm: Buffer.from(audio.data, 'base64'), rate }
}

async function geminiSpeech(text) {
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt === WAIT_MS.length
    try {
      return await geminiSpeechOnce(text, !last)
    } catch (err) {
      if (last || !err.retry) throw err
      console.warn(`Voice try ${attempt + 1} failed, retrying:`, err.message)
      await new Promise((r) => setTimeout(r, WAIT_MS[attempt]))
    }
  }
}

// Raw 16-bit PCM -> OGG Opus, the format WhatsApp plays as a voice note.
function toVoiceNote(pcm, rate) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is not available'))
    const args = ['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-f', 'ogg', 'pipe:1']
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30000)
    proc.stdout.on('data', (c) => chunks.push(c))
    proc.on('error', reject)
    proc.on('close', (code) => {
      clearTimeout(timer)
      const ogg = Buffer.concat(chunks)
      code === 0 && ogg.length ? resolve(ogg) : reject(new Error(`ffmpeg exited with ${code}`))
    })
    proc.stdin.on('error', () => {})
    proc.stdin.end(pcm)
  })
}

// Returns { audio, seconds } ready to send, or null.
export async function speak(text) {
  if (!config.voiceReplies || !config.geminiApiKey) return null
  if (Date.now() < pausedUntil) return null
  const words = speakable(text)
  if (!words) return null
  try {
    const { pcm, rate } = await geminiSpeech(words)
    const audio = await toVoiceNote(pcm, rate)
    return { audio, seconds: Math.round(pcm.length / (rate * 2)) }
  } catch (err) {
    console.error('Voice reply failed, sending text instead:', err.message)
    return null
  }
}
