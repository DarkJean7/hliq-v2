// The Strats redesign: bots as cards, with what they do on the back.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- every bot has a description, and it is honest --')
const TYPES = ['accumulator', 'dca', 'grid', 'trend', 'longer', 'shorter', 'copytrade']
const about = cli.slice(cli.indexOf('const _STRAT_ABOUT = {'), cli.indexOf('const _stratFlipped'))
for (const ty of TYPES) t(`${ty} has an entry`, about.includes(ty + ': {'), ty)
t('every entry carries an icon and an accent',
  (about.match(/icon:/g) || []).length === TYPES.length && (about.match(/accent:/g) || []).length === TYPES.length)
// The risk line is the point: a description that only sells the bot is worse than none.
for (const k of ['tag:', 'what:', 'why:', 'risk:'])
  t(`every entry carries ${k}`, (about.match(new RegExp(k, 'g')) || []).length === TYPES.length, k)
t('all four fields are translated', (about.match(/_T\(/g) || []).length >= TYPES.length * 4)
t('why the risk line exists is recorded', cli.includes('it is the one marketing copy always leaves out'))

// Spot-check that the text describes the real mechanism, not a slogan.
t('grid names its actual mechanic', about.includes('reduce-only sells above it'))
t('and its actual failure mode', about.includes('leaves the range in one direction'))
t('accumulator explains WHY spot is safer here', about.includes('only USDC is perp collateral'))
t('dca warns that averaging down adds size to a loser', about.includes('adds size to a losing position'))
t('trend admits crossovers lag', about.includes('lag by design'))
t('shorter states the asymmetry plainly', about.includes('a rally has no ceiling'))
t('copytrade admits you always fill after them', about.includes('you always fill after they do'))

console.log(String.fromCharCode(10) + '-- the flip --')
t('flip state is per bot', cli.includes('const _stratFlipped = new Set()'))
t('and is NOT persisted', !cli.includes("localStorage.setItem('hliq_strat_flip"))
t('why not is recorded', cli.includes('not a mode to be left in'))
t('the toggle is exposed for the buttons', cli.includes('window.__stratFlip = function(type, on)'))
t('the ? button does not also expand the card', cli.includes(`event.stopPropagation();window.__stratFlip('\${s.type}',true)`))
t('and the close button flips back', cli.includes(`event.stopPropagation();window.__stratFlip('\${s.type}',false)`))
t('both faces exist in the markup', cli.includes('class="strat-face strat-front"') && cli.includes('class="strat-face strat-back"'))

console.log(String.fromCharCode(10) + '-- only the visible face sizes the card --')
// Stacking both faces in one grid cell made every collapsed card as tall as its own
// description: a screen of mostly empty boxes.
t('the hidden back is taken out of flow', css.includes('.strat-back { transform: rotateY(180deg); padding: 13px 14px 15px; position: absolute; inset: 0;'))
t('and takes over when flipped', css.includes('.mob-strat-card.strat-flipped .strat-back  { position: relative; inset: auto;'))
t('while the front steps out', css.includes('.mob-strat-card.strat-flipped .strat-front { position: absolute; inset: 0; }'))
t('the flip container is the positioning context', css.includes('.strat-flip { position: relative;'))
t('the lesson is written down', css.includes('a screen of mostly empty'))
t('backface is hidden both ways', css.includes('backface-visibility: hidden; -webkit-backface-visibility: hidden'))
t('the turn respects reduced motion', css.includes('@media (prefers-reduced-motion: reduce) { .strat-flip { transition: none; } }'))
t('and so does the running pulse', css.includes('@media (prefers-reduced-motion: reduce) { .strat-live i { animation: none } }'))

console.log(String.fromCharCode(10) + '-- each bot carries its own colour --')
t('the accent is set per card', cli.includes('style="--strat-accent:${meta?.accent'))
t('the badge uses it', css.includes('background: color-mix(in oklch, var(--strat-accent) 15%, transparent)'))
t('a running card is tinted with it, not one shared green',
  css.includes('.mob-strat-card.mob-strat-running { border-color: color-mix(in oklch, var(--strat-accent) 55%, transparent); }'))
t('why per-bot colour helps is recorded', css.includes('identifies WHICH bot is running'))
t('a running card says so on its face', cli.includes('class="strat-live"'))

console.log(String.fromCharCode(10) + '-- opening from the menu lands expanded, with a way back --')
t('the More drawer opens Strats full screen', cli.includes("if (name === 'strategies') { _stratsFull = true; _stratsApplyFull() }"))
t('why is recorded', cli.includes('the densest view'))
t('there is a Back button', cli.includes('function _stratsCloseBtn()'))
t('it leaves full screen AND returns home', cli.includes('_stratsExitFull()\n  window.mobVHome()'))
t('it is rendered in the header', cli.includes('${_stratsWhyUnlocked()}${_stratsFullBtn()}${_stratsCloseBtn()}${serverBadge}'))
t('it is labelled, not just an icon', cli.includes("${_T('Back', 'Volver')}"))
t('and carries an aria-label', cli.includes(`aria-label="\${_T('Close', 'Cerrar')}"`))
t('why the button was needed is recorded', css.includes('Bot cards') || cli.includes('only way back was the'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
