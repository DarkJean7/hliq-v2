// Recognising a guard that is already armed.
//
// Reported: "when the user have already set one it just keeps looking like i havent set one
// already, making it imposible to cancel the arms, edit them, etc."
//
// The modal's whole armed state — the Edit title, the Disarm button, the Logs button, the
// prefilled config, the Update verb — hangs off one boolean. It was computed as
//
//     !!serverStatus._instances[`${mode}:${coin.toUpperCase()}`]
//
// which misses an armed guard two ways, and the reported position hit both: a HIP-3 coin in
// the combined view. The position card's shield badge had already got both right, so the badge
// said armed while the modal said not.
import fs from 'fs'
import { armedGuardKey, firedSummary } from '../../src/guardkey.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const ACCT = '0xAA7Ad5Fa0000000000000000000000000535381'
const inst = (...keys) => Object.fromEntries(keys.map(k => [k, true]))

console.log(nl + '-- the plain case still works --')
t('an armed guard is found', armedGuardKey('liqguard', 'BTC', null, { instances: inst('liqguard:BTC') }) === 'liqguard:BTC')
t('and an unarmed one is not', armedGuardKey('liqguard', 'BTC', null, { instances: inst('liqguard:ETH') }) === null)
t('the mode matters', armedGuardKey('levbrake', 'BTC', null, { instances: inst('liqguard:BTC') }) === null)
t('a lev brake is found on its own key',
  armedGuardKey('levbrake', 'BTC', null, { instances: inst('levbrake:BTC') }) === 'levbrake:BTC')

console.log(nl + '-- CASE: a HIP-3 market is not an uppercase ticker --')
{
  // The server writes the market as it is: `liqguard:hype2:CHIP`. Asking for HYPE2:CHIP found
  // nothing, so the modal offered a blank Arm form for a guard that was already running.
  const I = inst('liqguard:hype2:CHIP')
  t('the key is returned as the SERVER wrote it',
    armedGuardKey('liqguard', 'hype2:CHIP', null, { instances: I }) === 'liqguard:hype2:CHIP')
  t('and the coin is matched whatever case it arrives in',
    armedGuardKey('liqguard', 'HYPE2:CHIP', null, { instances: I }) === 'liqguard:hype2:CHIP')
  t('the old uppercase lookup would have missed it', I['liqguard:' + 'hype2:CHIP'.toUpperCase()] === undefined)
  // Returning the server's spelling matters: the caller looks the config and counters up by it.
  t('a mixed-case instance is still found under a lowercase ask',
    armedGuardKey('liqguard', 'xyz:smsn', null, { instances: inst('liqguard:xyz:SMSN') }) === 'liqguard:xyz:SMSN')
}

console.log(nl + '-- OWNERSHIP: the selected account is not the owning one --')
{
  // serverStatus._instances describes whichever wallet is selected. In the combined view the
  // position belongs to another one, and _maBotStatus is the only record that knows.
  const byWallet = { [ACCT.toLowerCase()]: ['liqguard:hype2:CHIP', 'grid:SOL'] }
  t('the owning wallet answers even when instances is empty',
    armedGuardKey('liqguard', 'hype2:CHIP', ACCT, { instances: {}, byWallet }) === 'liqguard:hype2:CHIP')
  t('the address is matched case-insensitively',
    armedGuardKey('liqguard', 'hype2:CHIP', ACCT.toUpperCase(), { instances: {}, byWallet }) === 'liqguard:hype2:CHIP')
  t('a different wallet does not answer for this one',
    armedGuardKey('liqguard', 'hype2:CHIP', '0xbeef', { instances: {}, byWallet }) === null)
  // The owning wallet is asked FIRST: with both present its record is the one that describes
  // this position.
  t('the owner wins over the selected account',
    armedGuardKey('liqguard', 'SOL', ACCT,
      { instances: inst('liqguard:sol'), byWallet: { [ACCT.toLowerCase()]: ['liqguard:SOL'] } }) === 'liqguard:SOL')
  t('and the selected account still answers when there is no owner',
    armedGuardKey('liqguard', 'SOL', null, { instances: inst('liqguard:SOL'), byWallet }) === 'liqguard:SOL')
  t('a wallet with no bots at all is not a crash',
    armedGuardKey('liqguard', 'SOL', ACCT, { instances: {}, byWallet: { [ACCT.toLowerCase()]: null } }) === null)
}

console.log(nl + '-- nothing to go on --')
{
  t('no sources at all', armedGuardKey('liqguard', 'BTC', null) === null)
  t('empty sources', armedGuardKey('liqguard', 'BTC', null, { instances: {}, byWallet: {} }) === null)
  t('no coin', armedGuardKey('liqguard', '', null, { instances: inst('liqguard:') }) === null)
  t('no mode', armedGuardKey('', 'BTC', null, { instances: inst(':BTC') }) === null)
}

console.log(nl + '-- WHAT IT HAS ALREADY SPENT --')
{
  // Reported: "still missing the already placed fires, so the user can decide if add more and
  // update it." Editing a guard is a decision about giving it more room; the form alone does
  // not say how much room is left.
  const s = firedSummary(1, 12.5, { maxFires: 4, cap: 40 })
  t('the fires used and the cap allowed are both reported',
    s.fires === 1 && s.maxFires === 4 && s.added === 12.5 && s.cap === 40, JSON.stringify(s))
  t('and what is LEFT, which is the number the decision turns on',
    s.firesLeft === 3 && s.addLeft === 27.5, JSON.stringify(s))
  t('a guard with room is not exhausted', s.exhausted === false)

  t('a guard that has used every fire is out of room',
    firedSummary(4, 10, { maxFires: 4, cap: 40 }).exhausted === true)
  t('and so is one that has spent its whole cap',
    firedSummary(1, 40, { maxFires: 4, cap: 40 }).exhausted === true)
  t('overspending past the cap does not report negative room left',
    firedSummary(9, 55, { maxFires: 4, cap: 40 }).addLeft === 0)

  // Raising the cap in the FORM is the move the line exists to support: the numbers must be
  // read against what is on screen now, not what the guard was armed with.
  t('raising the cap in the form buys room immediately',
    firedSummary(1, 40, { maxFires: 4, cap: 100 }).exhausted === false &&
    firedSummary(1, 40, { maxFires: 4, cap: 100 }).addLeft === 60)

  t('a guard that has never fired still reports its zero',
    firedSummary(0, 0, { maxFires: 2, cap: 20 }).used === false)
  // Blank is how the cap field ships: no limit set is not a limit of zero, which would make
  // every armed guard read as exhausted the moment the modal opened.
  t('a blank cap is no limit, not a limit of zero',
    firedSummary(1, 12.5, { maxFires: 2, cap: '' }).cap === null &&
    firedSummary(1, 12.5, { maxFires: 2, cap: '' }).exhausted === false)
  t('a blank fire count likewise', firedSummary(1, 12.5, {}).maxFires === null)
  t('form values arrive as strings and are still arithmetic',
    firedSummary(1, 12.5, { maxFires: '4', cap: '40' }).addLeft === 27.5)

  // Unknown is not zero. The counters live with the owning wallet; a view that cannot see
  // them must say so rather than print a 0 that reads as "it has never fired".
  t('unknown fires is unknown, not none', firedSummary(null, 12.5, { cap: 40 }) === null)
  t('unknown added is unknown, not none', firedSummary(1, null, { cap: 40 }) === null)
  t('nothing at all is unknown', firedSummary(null, null) === null)
}

console.log(nl + '-- and the modal reads that config off the wallet that owns it --')
{
  const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  t('main.js imports the summary', /import \{[^}]*firedSummary[^}]*\} from '\.\/guardkey\.js'/.test(CLI))
  t('and renders the fired row through it', CLI.includes('const s = firedSummary(cfg.fires, cfg.added, {'))
  t('the row exists in the markup',
    fs.readFileSync('index.html', 'utf8').includes('id="guardFiredVal"'))
  // Armed on another wallet: serverStatus holds no config for it, so every field on screen is
  // a DEFAULT. Pressing Update then would relaunch a running guard with a form nobody filled.
  t('an armed guard with no local config is fetched from its owner',
    CLI.includes('async function _guardFetchOwnerState(mode, coin, acct, armedKey)') &&
    CLI.includes("serverFetch('/api/status?address=' + encodeURIComponent(acct))"))
  t('the fetch is wired to the armed-but-unknown case',
    CLI.includes('if (running && !gStatus && _isRealAddr(guardAcct)) {'))
  t('Update is held shut until the real config lands',
    CLI.includes('function _guardSetUpdateReady(ready)') &&
    CLI.includes('btn.disabled = !ready'))
  t('and stays shut when the wallet cannot be read',
    /_guardSetUpdateReady\(false\)[\s\S]{0,200}?Unavailable/.test(CLI))
  t('the fetched config fills the form', CLI.includes('function _guardApplyLive(g)') &&
    CLI.includes("set('guardTrigPct',  live['trigger-pct'])"))
  // The modal may have been closed or reopened elsewhere while the fetch was in flight.
  t('a stale response does not overwrite another position',
    CLI.includes('if (state.guardCfg?.coin !== forCoin || state.guardCfg?.mode !== forMode) return'))
  // Editing the cap changes what the line means, so it is redrawn on every preview.
  t('the line follows edits to the cap and the fire count',
    /__guardPreview = function \(\) \{[\s\S]{0,400}?_guardFiredSummary\(g\)/.test(CLI))
}

console.log(nl + '-- and the modal uses it for all three questions --')
{
  const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  t('main.js imports it', CLI.includes("from './guardkey.js'"))
  t('the modal resolves the key once', CLI.includes('const armedKey = _armedGuardKey(mode, coin, guardAcct)'))
  t('armed-ness comes from that key', CLI.includes('const running  = !!armedKey'))
  // Three separate lookups of the same thing is how they drifted apart in the first place.
  t('and so do the counters', CLI.includes('serverStatus?._guards?.[armedKey]'))
  t('and the prefilled config', CLI.includes('const live = gStatus ? _parseGuardArgs(gStatus.args) : null'))
  t('no uppercase instance lookups are left',
    !/_instances\?\.\[`\$\{mode\}:\$\{String\(coin\)\.toUpperCase\(\)\}`\]/.test(CLI) &&
    !/_guards\?\.\[`\$\{mode\}:\$\{String\(coin\)\.toUpperCase\(\)\}`\]/.test(CLI))

  // Armed on another wallet means armed WITHOUT its counters. Zero would claim it has never
  // fired, which is a different statement from "this view cannot see how often it has".
  t('an uncounted guard reports null rather than zero',
    CLI.includes('added: gStatus ? (parseFloat(gStatus.added) || 0) : null') &&
    CLI.includes('fires: gStatus ? (parseInt(gStatus.fires) || 0) : null'))
  t('and the plan says so instead of implying none', CLI.includes('function _guardFiresNote(unknown)') &&
    CLI.includes('const firesUnknown = g.running && g.fires == null'))
  // A contiguous fragment: the comment wraps, so the whole sentence never sits on one line.
  t('why the old lookup missed is written down',
    fs.readFileSync('src/guardkey.js', 'utf8').includes('armed while the modal said not'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
