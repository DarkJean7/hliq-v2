/**
 * Run any bot on a paper account: node --import ./strategies/_paperpreload.js <bot> … --paper <slot>
 *
 * The server starts every paper bot this way (server.js startStrategy). Before the bot's own
 * code runs, this puts the paper exchange (src/paperexchange.js) in front of fetch, so the bot —
 * unchanged, the same file that trades live — trades the paper account instead of Hyperliquid.
 *
 * What arrives in AGENT_KEY for a paper bot is the paper OWNER's secret, never a wallet key; it
 * is taken here and the bot is handed a throwaway key to sign with, since nothing checks a paper
 * order's signature. Without --paper this does nothing at all.
 */
import path from 'node:path'
import { ethers } from 'ethers'
import { installPaperExchange } from '../src/paperexchange.js'

const argv = process.argv
const i = argv.indexOf('--paper')
if (i > 0) {
  const slot = String(argv[i + 1] ?? '')
  const secret = String(process.env.AGENT_KEY ?? '')
  const a = argv.indexOf('--address')
  if (!/^[a-z0-9]{1,40}$/.test(slot) || !/^[0-9a-f]{64}$/.test(secret)) {
    console.error('ERROR: a paper run needs its paper account and owner')
    process.exit(1)
  }
  installPaperExchange({ secret, slot, addr: a > 0 ? argv[a + 1] : null,
    dir: process.env.PAPER_DIR || path.join(process.cwd(), 'data', 'paper'),
    log: (m) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [PAPER   ] ${m}`) })
  process.env.AGENT_KEY = ethers.Wallet.createRandom().privateKey
  // Taken out of the bot's arguments: a bot reads "--paper" as a flag and the account after it
  // as a stray positional, which most of them refuse. The bot never needs to know it is on
  // paper — that is the point. (The server keeps the pair in what it persists and shows.)
  globalThis.__paperSlot = slot
  process.argv.splice(i, 2)
}
