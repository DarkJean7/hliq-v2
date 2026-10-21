// Profile pictures: who may set one, and who can see it.
//
// Reported as: "make user uploaded account images appear also in the leaderboard. my friend
// did and i cannot see it."
//
// The leaderboard was never the problem — _lbAvatarHtml and _mobVAvatarHtml have always
// requested /pfp/<addr>, and four of the six live rows were serving real JPEGs. The UPLOADER
// was dev-only in two places at once: the camera button sat behind isDev(), and so did the
// handler behind it. Everyone else opened a file picker that did nothing — no upload, no
// error, not even a local copy. So the friend had not actually uploaded anything.
//
// Opening it to everyone meant closing something first. POST /pfp on serve-prod accepted ANY
// image for ANY address with no authentication whatsoever; the only thing in the way was that
// the button was hidden, which is not the same as the door being shut. On a board where every
// visitor sees these pictures, "who put this here" has to have an answer.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8')
const srv = fs.readFileSync('server.js', 'utf8')
const prod = fs.readFileSync('serve-prod.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig)
  if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- anyone can set their OWN picture --')
{
  const h = grab(cli, 'window._mobVHandlePfp = async function(input)')
  // Decommented: the comment explaining the removal quotes the line it removed.
  const code = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  t('the handler no longer refuses non-devs', !/if \(!isDev\(\)\) return/.test(code(h)), code(h).slice(0, 200))
  t('and it acts on the account the button offered', h.includes('const a = _pfpDrawerAddr()'))
  // _agentUiAddr returns null in the combined view, so in All Accounts — where the camera is
  // most visible — picking a file did nothing at all.
  // Decommented: the comment explaining the change names the call it replaced.
  t('not the one that is null in All Accounts', !code(h).includes('_agentUiAddr()'))
  t('why the old gate was not security is written down', cli.includes('holding it shut'))

  // The button itself has NO condition left. isDev() first, then "an account you can prove is
  // yours" — both hid it from exactly the people who had not set themselves up yet, so a
  // visitor with no wallet had no way to learn the feature existed.
  const drawer = cli.slice(cli.indexOf('id="mobVDrawerAvatar"'), cli.indexOf('mob-wallet-current-name'))
  t('the camera is shown to everyone', drawer.includes('onclick="window._mobVPickPfp()"'))
  t('with nothing gating it', !/isDev\(\)[\s\S]{0,80}_mobVPickPfp/.test(drawer) && !/_lbOwnsAddr[\s\S]{0,120}_mobVPickPfp/.test(drawer))
  t('and why hiding it was never the guard is recorded', cli.includes('hiding a button was never that guard'))

  // Pressing it explains what is missing, rather than the button being what is missing.
  const pick = grab(cli, 'window._mobVPickPfp = function()')
  t('no wallet connected offers the wallet picker', pick.includes('openWalletPicker()'))
  t('and says to come back to the camera', pick.includes('then tap the camera again'))
  // A programmatic input.click() after an await is blocked without a user gesture, so
  // promising to re-open the dialog would be promising something that silently fails.
  t('why it does not re-open the dialog itself is written down', cli.includes('only honour'))
  t('an account that is not yours is refused outright', pick.includes('That account is not yours'))

  const who = grab(cli, 'function _pfpDrawerAddr()')
  t('a real address in view must be provably yours', who.includes('_lbOwnsAddr(cur) ? cur : null'))
  // Falling back to the connected wallet from someone else's page would quietly change YOUR
  // picture while you were looking at their account.
  t('and never falls back to your own wallet from their page', who.includes('return _pfpOwnAddr()') && who.indexOf('_lbOwnsAddr') < who.indexOf('return _pfpOwnAddr()'))
  t('All Accounts targets the connected wallet, since it is not one', who.includes('_pfpOwnAddr()'))
  t('and the toast names it, because the combined avatar will not change',
    h.includes('state.isAllAccounts && WM.getLabel(a)'))
}

console.log(nl + '-- the image is re-encoded before it leaves the device --')
{
  const u = grab(cli, 'async function _pfpUpload(addr, file)')
  t('one uploader, shared by both pickers', u.length > 400)
  // The canvas pass moved into _pfpDataUrl so the dev picker shares it.
  const du = grab(cli, 'function _pfpDataUrl(file)')
  // The person frames it first now (src/imgedit.js), and the editor draws the 256px canvas:
  // "it should let the user resize, etc, and preview before putting it".
  const ed = fs.readFileSync('src/imgedit.js', 'utf8')
  t('drawn through a 256px canvas', u.includes('await _pfpDataUrl(file)') && du.includes("editImage(file, { kind: 'avatar', outW: 256, outH: 256")
    && ed.includes('out.width = outW; out.height = outH'))
  t('and emitted as jpeg', du.includes('quality: 0.88') && ed.includes("out.toDataURL('image/jpeg', quality)"))
  t('backing out of the editor uploads nothing and says nothing', u.includes('if (dataUrl === IMG_CANCELLED) return { ok: false, cancelled: true }'))
  // That pass is what drops EXIF. A phone photo carries a GPS tag, and this ends up on a
  // public board.
  t('why that matters is stated', cli.includes('which drops EXIF'))
  t('it posts to the authenticated route', u.includes("serverFetch('/api/pfp'"))
  t('as that account, so the session proves ownership', u.includes('authAddr: a'))
  t('and it clears the missing-mark so the change shows at once', u.includes('_pfpShowNew(a)') && grab(cli, 'function _pfpShowNew(a)').includes('_pfpForget(a)'))
  // The leaderboard picker used to send the raw file; now it goes the same way.
  t('the leaderboard picker uses it too', grab(cli, 'window.__lbChangePic = function(addr)').includes('_pfpUpload(addr, file)'))
}

console.log(nl + '-- an owner with no agent key can still set one --')
{
  // The server always took either proof: an agent key Hyperliquid confirms for the address,
  // or a signature from the address itself. The client only ever sent the first, so an owner
  // who had connected their wallet but never saved an agent key — most people, since the key
  // is only needed to TRADE from here — got "bad signature" and no picture. On a feature
  // whose whole point is that everyone can set one.
  const u = grab(cli, 'async function _pfpUpload(addr, file)')
  t('the silent proof is tried first', u.includes('if (_agentKeyGet(a))'))
  t('and a signature is the fallback, not the default', u.includes('const signature = await _pfpSign(a, ts)'))
  t('the signed request goes unauthenticated, since the signature IS the auth',
    u.includes("fetch('/api/pfp'") && u.includes('...body, signature'))
  // The ts that is signed has to be the ts that is sent, or the server rebuilds a different
  // message and every upload fails verification with nothing on screen to say why.
  t('one timestamp, signed and sent', u.includes('const ts   = Date.now()') && u.includes('const body = { addr: a, dataUrl, ts }'))
  t('declining the wallet prompt is not an error', cli.includes('Declining is an ordinary answer, not an error.'))

  const sg = grab(cli, 'async function _pfpSign(addr, ts)')
  t('it refuses to sign for another address', sg.includes('if (me !== String(addr).toLowerCase()) return null'))
  t('and needs a connected wallet at all', sg.includes('if (!isMainWalletConnected()) return null'))
  // Byte-for-byte what server.js rebuilds before ethers.verifyMessage.
  t('the message matches the one the server verifies',
    sg.includes('Insolvent Trade — set profile picture') && sg.includes('address: ${String(addr).toLowerCase()}') && sg.includes('ts: ${ts}'))
  t('and the server builds exactly that', srv.includes('Insolvent Trade — set profile picture'))
}

console.log(nl + '-- and there is a way in where the picture is seen --')
{
  // __lbChangePic had NO caller. The only control was a camera button inside the mobile
  // wallet drawer, which nobody finds — so "let everyone change their profile image" was
  // true in the code and false on the screen.
  t('the board offers it', cli.includes("window.__lbSetMyPic()"))
  t('on the mobile board', cli.includes('📷 My photo</button>'))
  t('and on the desktop one', /_lbDeskSortBar\(\)[\s\S]{0,200}__lbSetMyPic/.test(cli))
  const pick = grab(cli, 'window.__lbSetMyPic = function()')
  t('it resolves whose picture it may set', pick.includes('const a = _pfpOwnAddr()'))
  t('and says so plainly when it cannot', pick.includes('the picture is signed by its owner'))

  const own = grab(cli, 'function _pfpOwnAddr()')
  t('the account in view counts when it can be proved', own.includes('_lbOwnsAddr(cur)'))
  t('otherwise the connected wallet', own.includes('isMainWalletConnected()'))
  // __all_accounts__ and the paper sentinel are not addresses and have no picture.
  t('and never a sentinel', own.includes('/^0x[0-9a-f]{40}$/.test(cur)'))
}

console.log(nl + '-- the write is authenticated, the read is not --')
{
  const route = srv.slice(srv.indexOf("path === '/api/pfp'"), srv.indexOf("path === '/api/leaderboard/name'"))
  t('an agent-key session counts', route.includes('(!!auth && (auth.admin || await agentApprovedFor(b.addr, auth.signer)))'))
  // "let me be able to change the photos of users as dev": the operator PIN is a third proof.
  t('the dev PIN counts, for any account', route.includes("const byOperator = !!LB_PIN && pinHdr === LB_PIN") && route.includes('const byAgent = byOperator ||'))
  t('a wrong PIN is refused outright, not tried as a signature', route.includes("if (pinHdr && !byOperator) return json(res, 403"))
  t('and the log says it was the operator', route.includes("byOperator ? 'operator'"))
  const dev = grab(cli, 'window.__lbSetPhoto = async function(addr)')
  t('the dev picker is dev-only', dev.includes('if (!isDev() ||'))
  t('it sends the PIN and the same canvas pass', dev.includes("'x-lb-pin': p") && dev.includes('await _pfpDataUrl(file)'))
  t('a stale cached PIN gets one re-prompt', dev.includes("localStorage.removeItem('hliq_lb_pin'); pin = await _lbAdminPin(true)"))
  t('and the board repaints, so a letter avatar becomes the photo', dev.includes('_lbAfterRemove()'))
  t('desktop and mobile rows both offer it', (cli.match(/window\.__lbSetPhoto\('\$\{esc\((entry|r)\.addr\)\}'\)/g) ?? []).length === 2)
  t('otherwise a signature from that address is required', route.includes('ethers.verifyMessage(msg, b.signature'))
  t('and it must match', route.includes("error: 'signature does not match that address'"))
  t('a stale signature is refused', route.includes('stale request'))
  t('only real image types are accepted', route.includes('data:image\\/(jpeg|png|webp);base64,'))
  t('and a size a 256px jpeg cannot exceed', route.includes('buf.length > 600_000'))
  t('it writes where serve-prod reads from', route.includes("join(__dirname, 'data', 'pfp')"))
  t('and logs who set it', route.includes("console.log('[pfp]'"))

  // The old door.
  const pfp = prod.slice(prod.indexOf("url.startsWith('/pfp/')"), prod.indexOf("url.startsWith('/icon/')"))
  t('serve-prod still SERVES pictures', pfp.includes("if (req.method === 'GET')") && pfp.includes('serveFile(res, imgPath)'))
  t('but no longer accepts them', !pfp.includes('writeAtomic(imgPath'))
  t('and says where uploads went', pfp.includes('upload moved to POST /api/pfp'))
  t('the reason is recorded', pfp.includes('the only thing stopping a'))
}

console.log(nl + '-- a picture uploaded while you are looking still turns up --')
{
  // Held for the whole session, a 404 cached before your friend uploaded meant a letter
  // avatar until you reloaded — which is the other half of "i cannot see it".
  t('the missing-mark expires', cli.includes('const _PFP_MISS_TTL = 5 * 60_000'))
  t('and is checked against a time, not just membership',
    cli.includes('if (Date.now() - t > _PFP_MISS_TTL)'))
  t('the board asks for the picture at all', cli.includes('<img src="/pfp/${addr.toLowerCase()}"'))
  t('with a letter avatar behind it when there is none', cli.includes('_avatarFallbackHtml(addr, size)'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
