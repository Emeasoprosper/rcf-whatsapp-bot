import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

// Cooldowns off for testing. Set before handler/config load.
process.env.GROUP_COOLDOWN_SECONDS = '0'
process.env.SENDER_COOLDOWN_SECONDS = '0'

const { handleMessage } = await import('./handler.js')

const rl = readline.createInterface({ input, output })
console.log('Local test chat. Type a message as a group member.')
console.log('Start with "@bot " to tag the bot. Type "exit" to quit.\n')

let n = 0
while (true) {
  const line = (await rl.question('You: ')).trim()
  if (!line) continue
  if (line.toLowerCase() === 'exit') break

  n += 1
  const tagged = /^@bot\b/i.test(line)
  const text = line.replace(/^@bot\b\s*/i, '')
  const reply = await handleMessage({
    id: `local-${n}`,
    senderId: `tester-${n}`,
    text,
    isGroup: true,
    fromMe: false,
    mentionedBot: tagged,
  })
  console.log(reply ? `\nBot: ${reply}\n` : '\n(bot stays silent)\n')
}
rl.close()