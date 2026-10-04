// / is the landing page and the app is /app. Returning users must never see the landing:
// the people who used the app before it existed open insolvent.trade and expect their
// terminal, and an installed PWA whose start_url was "/" still opens there.
//
// The redirect is an inline script in landing.html's <head>, so this suite RUNS it against
// a fake location and localStorage rather than only reading it.
import fs from 'fs'
import vm from 'vm'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'

const LANDING = fs.readFileSync('landing.html', 'utf8')
const APP     = fs.readFileSync('index.html', 'utf8')
const PROD    = fs.readFileSync('serve-prod.js', 'utf8')
const VITE    = fs.readFileSync('vite.config.js', 'utf8')
const MANI    = JSON.parse(fs.readFileSync('public/manifest.json', 'utf8'))
const SW      = fs.readFileSync('public/sw.js', 'utf8')
const CI      = fs.readFileSync('.github/workflows/deploy.yml', 'utf8')

console.log(nl + '-- the redirect, executed --')
const script = LANDING.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1] ?? ''
t('landing.html has the inline redirect in <head>',
  script.includes('hliq_app_entered') && LANDING.indexOf(script) < LANDING.indexOf('</head>'))

function run({ search = '', hash = '', store = {}, standalone = false }) {
  const out = { replaced: null, history: null }
  const keys = Object.keys(store)
  const ctx = {
    URLSearchParams,
    location: { search, hash, replace: u => { out.replaced = u } },
    history:  { replaceState: (_a, _b, u) => { out.history = u } },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      key: i => keys[i] ?? null,
      get length() { return keys.length },
    },
    window: {},
    matchMedia: () => ({ matches: standalone }),
  }
  ctx.window.matchMedia = ctx.matchMedia
  vm.runInNewContext(script, ctx)
  return out
}

t('a first visit stays on the landing', run({}).replaced === null)
t('someone who launched the app goes straight to it',
  run({ store: { hliq_app_entered: '1' } }).replaced === '/app')
t('a user from before the landing existed (any hliq_ key) goes straight to it',
  run({ store: { hliq_wallets: '[]' } }).replaced === '/app')
t('an unrelated key does not count as having used the app',
  run({ store: { other_site: '1' } }).replaced === null)
t('an installed PWA always opens the app', run({ standalone: true }).replaced === '/app')
t('query and hash survive the redirect (shared links keep working)',
  run({ search: '?coin=BTC', hash: '#trade', store: { hliq_app_entered: '1' } }).replaced === '/app?coin=BTC#trade')
{
  const r = run({ search: '?home', store: { hliq_app_entered: '1' } })
  t('?home (the logo) shows the landing even to a returning user', r.replaced === null)
  t('and is stripped from the address bar', r.history === '/', r)
}
t('?home keeps any other params', run({ search: '?home&x=1', store: { hliq_app_entered: '1' } }).history === '/?x=1')

console.log(nl + '-- the app marks itself, and links home --')
t('the app sets hliq_app_entered before anything else runs',
  APP.indexOf("localStorage.setItem('hliq_app_entered', '1')") > 0 &&
  APP.indexOf("localStorage.setItem('hliq_app_entered', '1')") < APP.indexOf('</head>'))
t('desktop sidebar and topbar logos link to /?home',
  (APP.match(/<a class="insolvent-logo[^"]*notranslate" href="\/\?home"/g) ?? []).length === 2)
t('the mobile bar has the logo, linking to /?home, inside the Predictions handle',
  /id="mobPredictHandle"[\s\S]{0,400}<a class="mob-v-brand notranslate" href="\/\?home"/.test(APP))
t('a tap on it does not also open Predictions',
  /class="mob-v-brand[^>]*onclick="event\.stopPropagation\(\)"/.test(APP))
t('landing "Launch app" buttons go to /app',
  (LANDING.match(/href="\/app" data-launch/g) ?? []).length >= 3)

console.log(nl + '-- routes --')
t('prod serves landing.html at /', /url === '\/' \? 'landing\.html'/.test(PROD))
t('prod serves /app whatever Sec-Fetch-Dest says (SW re-fetch sends empty)', PROD.includes("if (url === '/app') return serveFile(res, join(DIST, 'index.html'))"))
t('the service worker leaves page loads alone', SW.includes("if (request.mode === 'navigate') return"))
t('prod sends /app/ to /app', PROD.includes("url === '/app/'"))
t('/app is answered by the navigation fallback with index.html',
  /serveFile\(res, join\(DIST, 'index\.html'\)\)\s*\n\}\)\.listen/.test(PROD))
t('dev and preview rewrite / the same way',
  VITE.includes("req.url = '/landing.html'") && VITE.includes('configurePreviewServer'))
t('both pages are build inputs, app keyed index (bundle stays assets/index-*.js)',
  /index:\s*join\(__dirname, 'index\.html'\)/.test(VITE) && /landing:\s*join\(__dirname, 'landing\.html'\)/.test(VITE))
t('installed app opens /app', MANI.start_url === '/app')
t('a notification tap opens /app', SW.includes("clients.openWindow('/app')"))
t('CI ships landing.html', CI.includes('rsync -avz landing.html'))
t('the landing does not pull in the app', !/^import\b.*(main\.js|style\.css)/m.test(fs.readFileSync('src/landing.js', 'utf8')))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
