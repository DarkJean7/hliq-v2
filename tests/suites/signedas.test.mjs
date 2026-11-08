// Hyperliquid acts for whoever SIGNED (src/wallet.js getHlSigner).
//
// Reported: a Send "from 0x974e…" to 0xaa7a… came back "Invalid send". The app asks the wallet
// to sign as the account on screen, but a wallet holding several accounts can sign with the one
// it has selected -- and Hyperliquid then sees 0xaa7a… sending to itself. The same mismatch on
// an order would place it on the wrong account. The signer now recovers the address from the
// signature and stops on a mismatch. This proves that recovery is right for the payload the SDK
// really builds: no false alarm for the right wallet, a catch for the wrong one.
import fs from 'fs'
import { ethers } from 'ethers'
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const src = fs.readFileSync('src/wallet.js', 'utf8').replace(/\r\n/g, '\n')

const a = ethers.Wallet.createRandom(), b = ethers.Wallet.createRandom()
async function recovered(w, claim, act) {
  let who = null
  const wallet = {
    getAddress: async () => claim,
    provider: { getNetwork: async () => ({ chainId: 42161n }) },
    signTypedData: async (domain, types, message) => {
      who = ethers.verifyTypedData(domain, types, message, await w.signTypedData(domain, types, message))
      throw new Error('stop')                // never reaches the network
    },
  }
  try { await act(new ExchangeClient({ transport: new HttpTransport(), wallet })) } catch {}
  return who
}
const send = (c) => c.sendAsset({ destination: b.address, sourceDex: 'spot', destinationDex: 'spot', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '1', fromSubAccount: '' })
const order = (c) => c.order({ orders: [{ a: 0, b: true, p: '1', s: '1', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' })

t('a send signed by the account on screen recovers to it -- no false alarm', (await recovered(a, a.address, send))?.toLowerCase() === a.address.toLowerCase())
t('one signed by a different account is caught', (await recovered(b, a.address, send))?.toLowerCase() === b.address.toLowerCase())
t('the same holds for an order (an L1 action, signed differently)', (await recovered(a, a.address, order))?.toLowerCase() === a.address.toLowerCase())
t('the signer checks and stops on a definite mismatch', src.includes('ethers.verifyTypedData(domain, types, message, sig)') && src.includes('Your wallet signed as'))
t('but a check that cannot run does not block a signature', /try \{ who = ethers\.verifyTypedData[^}]*\} catch \(_\) \{\}/.test(src))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
