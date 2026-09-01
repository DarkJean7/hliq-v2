// Celebrations. The animation is not the risky part -- firing on a reading that is not
// real is, because a confetti burst over a number the user never actually had is the app
// lying to them about their own money. Every assertion here guards one of those.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const fx  = fs.readFileSync('src/celebrate.js', 'utf8').replace(/\r\n/g, '\n')
const htm = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- it never invents a high --')
// Without a silent seed, the first load of any account beats a non-existent record and
// every user is congratulated for existing.
t('a first sighting seeds without celebrating',
  cli.includes("if (!prev || !Number.isFinite(prev.v)) { map[key] = { v: eq, t: Date.now() }; _athSave(map); return }"))
// The bug class this file has hit three times: an empty read is "we did not look".
t('an unknown equity returns null, not zero', cli.includes('function _fxEquity()') &&
  cli.includes('if (!state.perpState?.marginSummary) return null'))
t('a real account also waits for its history',
  cli.includes("if (!isPaper() && !(state.fills?.length > 0 || state.webData)) return null"))
t('and a zero or NaN value is not a value', cli.includes('return Number.isFinite(v) && v > 0 ? v : null'))

console.log(String.fromCharCode(10) + '-- the combined total counts, but is keyed by what is in it --')
// Excluding All Accounts meant the feature never fired for anyone running several wallets,
// which is most of the people who would want it. Including it needs the key to say WHICH
// wallets, or hiding one reads as a loss and unhiding it reads as a record.
t('the key names every visible wallet', cli.includes("return addrs.length ? 'all:' + addrs.join(',') : null"))
t('and is order-independent, so a reorder is not a new account', cli.includes(".map(r => String(r.addr).toLowerCase()).sort()"))
t('a hidden wallet is out of both the key and the sum', cli.includes('.filter(r => r && !r.error && !hidden.has(r.addr))'))
t('a partial load is not a total', cli.includes('if (_allAcctIncomplete) return null'))
t('nor is one with a failed wallet in it', cli.includes('if (!rows.length || rows.some(r => r.error)) return null'))
t('the combined view gets BOTH checks', cli.includes('try { _fxCheckAth(key, eq); _fxCheckWin(key, eq) } catch {}'))
// Merged fills already carry the wallet that made them, so a win in the combined view is
// attributed and scaled to that wallet. Against a nine-wallet total, a great trade on a
// small account could never clear the threshold.
t('a win carries the wallet that made it',
  fs.readFileSync('src/perfhistory.js', 'utf8').includes("acctAddr: f._acctAddr ?? '',"))
t('and measured against the wallet that made it', cli.includes('const base = best.acctAddr ? (_fxAcctEquity(best.acctAddr) ?? eq) : eq'))
t('matched on address, not on a display label', cli.includes('String(r.addr).toLowerCase() !== String(addr).toLowerCase()'))
t('an unmatched wallet falls back rather than reading as zero', cli.includes('return Number.isFinite(v) && v > 0 ? v : null'))
t('the banner names the wallet', cli.includes("(best.acct ? ' - ' + esc(best.acct) : '')"))

console.log(String.fromCharCode(10) + '-- paper money and real money never mix --')
t('the key separates them', cli.includes("if (isPaper()) return 'paper:' + paperSlot()"))
t('and separates wallets', cli.includes("return state.addr ? 'w:' + String(state.addr).toLowerCase() : null"))
t('the win watcher re-seeds when the account changes',
  cli.includes("if (_fxWinKey !== key || _fxWinSeen === null) { _fxWinKey = key; _fxWinSeen = newest; return }"))

console.log(String.fromCharCode(10) + '-- it does not nag --')
t('a new peak must be a real move, not a tick', cli.includes("if (gain < 1 || gain / prev.v < 0.0025) return"))
t('the peak is recorded even when not celebrated',
  cli.indexOf('_athSave(map)\n\n  // Beating your old peak') > 0)
t('an all-time high holds a five-minute cooldown', cli.includes('if (!_fxGate(300000)) return'))
t('one banner at a time', cli.includes('function _fxGate(ms)') && cli.includes('_fxLastFire = Date.now()'))
t('a win is sized against equity, not a flat number', cli.includes('if (best.net < 1 || best.net / base < 0.01) return'))

// Reported from a real phone: opening the app produced a $28 celebration that was several
// trades summed, from hours earlier. Both halves of that were wrong.
t('one trade, not a session summed', cli.includes('collapseFills(fills.filter(f => (f.time ?? 0) > since))'))
t('and it is the SAME grouping the history sheet uses', cli.includes("import { historyHtml, collapseFills } from './perfhistory.js'"))
t('only a trade that just closed', cli.includes('now - r.time <= FX_WIN_FRESH_MS'))
t('the window is minutes, not hours', /FX_WIN_FRESH_MS = 10 \* 60 \* 1000/.test(cli))
t('the best single trade, never a total', cli.includes('rows.reduce((b, r) => r.net > (b?.net ?? -Infinity) ? r : b, null)'))
t('an order is scoped to its wallet before it is merged',
  fs.readFileSync('src/perfhistory.js', 'utf8').includes("const key = (f._acctAddr ?? '') + '|' + (f.oid != null"))

console.log(String.fromCharCode(10) + '-- it cannot break the app --')
t('a throw cannot take down the render', /try \{ _fxCheckAth\(key, eq\);.*\} catch \{\}/.test(cli))
t('the canvas never eats a click', fx.includes('pointer-events:none'))
t('the canvas removes itself', fx.includes("cv.remove(); return"))
t('a second burst replaces the first', fx.includes("document.getElementById('fxCanvas')?.remove()") &&
  fx.includes("document.getElementById('fxBanner')?.remove()"))
t('particle count is capped for phones', fx.includes('Math.min(160, Math.round(W / 7))'))

console.log(String.fromCharCode(10) + '-- it can be turned off --')
t('reduced motion drops the particles', fx.includes('if (!reducedMotion()) confetti(p.colors, p.burst)'))
t('but keeps the banner, which carries the message', fx.indexOf('banner(title, big, sub, p.color, p.hold)') <
  fx.indexOf('if (!reducedMotion())'))
t('celebrations are opt-out, so an unset key means on', fx.includes("localStorage.getItem(FX_KEY) !== '0'"))
t('the setting exists in Settings', htm.includes('id="celebrateToggle"'))
// Mobile is the primary surface; a setting that only exists on desktop does not exist.
t('and on mobile, which is the primary surface', cli.includes("${tog(fxEnabled(), 'window.__toggleCelebrate(this.checked)')}"))
t('with the preview there too', cli.includes(`onclick="window.__celebratePreview()">Preview</button>`))
t('and its state is restored from fxEnabled, not from a truthy key',
  cli.includes('if (fxToggle) fxToggle.checked = fxEnabled()'))
t('every entry point honours the setting', fx.includes('if (!fxEnabled()) return false'))
t('the preview shows what you are agreeing to', htm.includes('window.__celebratePreview()'))
t('and does not flip the setting on', cli.includes('if (!wasOn) setFxEnabled(false)'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
