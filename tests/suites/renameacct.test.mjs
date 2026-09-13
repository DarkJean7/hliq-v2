// Renaming an account from the phone.
//
// Reported: "add an option in mobile to be able to change account name". Mobile could name an
// account when ADDING it and never again — the wallet drawer had a ✎ on paper accounts, an eye
// and a ✕ on real ones, and no way to fix a typo. Desktop has had __panelRename in the account
// panel and the Accounts tab has __maRename; the drawer is the third place, and the one someone
// is actually looking at when they want it.
//
// Two entry points, because one is not enough: the rows, AND the account you are standing in —
// which in single-account mode is deliberately dropped from the list below, so the row-only
// version would rename every account except the likeliest one.
import fs from 'fs'

const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const CSS = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

const grab = (sig) => {
  const start = CLI.indexOf(sig)
  if (start < 0) throw new Error('not found: ' + sig)
  let i = CLI.indexOf('{', start), depth = 0
  for (; i < CLI.length; i++) {
    if (CLI[i] === '{') depth++
    else if (CLI[i] === '}') { depth--; if (depth === 0) return CLI.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const FN = grab('window._mobVRenameWallet = async function(addr)')

console.log(nl + '-- it is reachable from both places a name is shown --')
{
  // The drawer header, for the account you are in.
  t('the current account has a pencil beside its name',
    CLI.includes('<button class="mob-wallet-name-edit" title="Rename this account"'))
  // The glyph is ~12px wide; a finger is not.
  {
    const rule = CSS.slice(CSS.indexOf('.mob-wallet-name-edit {'))
    const h = parseInt((rule.match(/min-height:\s*(\d+)px/) || [])[1] ?? '0')
    t('and it is styled as a tap target, not just a glyph', h >= 30, h)
  }
  // Every saved wallet row.
  t('each saved wallet row has one too',
    CLI.includes(`window._mobVRenameWallet('\${esc(w.addr)}')`))
  t('next to the remove button it already had',
    /_mobVRenameWallet\('\$\{esc\(w\.addr\)\}'\)[\s\S]{0,260}_mobVRemoveWallet\('\$\{esc\(w\.addr\)\}'\)/.test(CLI))
}

console.log(nl + '-- and it points at the right renamer for each kind of account --')
{
  // Paper keeps its own: renaming a paper account also has to move its entry on the paper
  // leaderboard, which WM knows nothing about.
  t('paper uses the paper renamer', CLI.includes("_isPaperCur ? 'window.__paperRename()'"))
  t('a real wallet uses the new one', CLI.includes("window._mobVRenameWallet('${esc(state.addr)}')"))
  // All Accounts is a view over wallets, not a wallet. There is no name to change.
  t('All Accounts gets no pencil at all', /_isAll \? ''\s*\n\s*: `<button class="mob-wallet-name-edit"/.test(CLI))
  t('why the header needs its own is written down', CLI.includes('is not in the list below'))
}

console.log(nl + '-- the name is bounded, and a blank one is refused --')
{
  // The one piece of real logic: pull the validator out and run it.
  const src = FN.match(/validate: (v => [\s\S]*?),\n/)
  if (!src) { t('the validator can be read out of the source', false, FN.slice(0, 200)) }
  else {
    const validate = new Function('return ' + src[1])()
    t('the validator can be read out of the source', true)
    t('a name is required', validate('') === 'Please enter a name.')
    t('and whitespace is not a name', validate('   ') === 'Please enter a name.')
    t('24 characters is fine', validate('x'.repeat(24)) === null)
    t('25 is not', /24 characters or fewer/.test(validate('x'.repeat(25))))
    // Trimmed before measuring, so trailing spaces cannot push a legal name over.
    t('the limit is measured after trimming', validate(' ' + 'x'.repeat(24) + ' ') === null)
    t('an ordinary name passes', validate('Cold storage') === null)
  }
}

console.log(nl + '-- saving it updates everything that shows the old name --')
{
  t('the label is written through WM', FN.includes('WM.upsert(addr, label)'))
  // WM.save re-registers the push subscription, which carries the label so an alert can say
  // WHICH account is near liquidation. That is also why the sheet does not claim privacy.
  t('and that is what re-syncs push alerts', FN.includes('re-syncs the push subscription'))
  // Scoped to what the USER reads, not to the comments around it.
  {
    const body = (FN.match(/body: ([\s\S]*?),\s*placeholder:/) || [, ''])[1]
    t('the sheet does not promise the name stays on the device only',
      body.length > 0 && !/never (sent|leaves)|private|only you/i.test(body), body)
    t('it says where the name shows up instead', body.includes('in its push alerts'))
  }
  // The combined view caches labels on its rows; refetching nine wallets to change a string
  // would be absurd.
  t('the All Accounts cache is patched, not refetched',
    FN.includes('r.label = label') && !FN.includes('_allAcctFetch'))
  t('the header, the strip and the saved list all repaint',
    FN.includes('renderWalletStrip(state.addr)') && FN.includes('renderSavedWallets()') &&
    FN.includes('_mobVRenderHeader()'))
  t('and the drawer redraws with the new name', FN.includes('window._mobVOpenWalletSwitch()'))
}

console.log(nl + '-- and it refuses to act on things that are not wallets --')
{
  t('the sentinels and junk are rejected up front', FN.includes('if (!_isRealAddr(addr)) return'))
  // Dismissing the sheet returns null; an unchanged name is not a write.
  t('a dismissed sheet writes nothing', FN.includes('if (name === null) return'))
  t('and neither does the same name again', FN.includes('if (!label || label === cur) return'))
  // Naming an address you are only watching adds it to your accounts. That is a change to
  // state, so it is said before it happens.
  t('saving an unsaved address says that it saves it',
    FN.includes('Naming this address also saves it to your accounts'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
