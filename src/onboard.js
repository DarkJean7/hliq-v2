// ─── ONBOARDING & HELP ─────────────────────────────────────────────────────────
// Everything that helps a first-timer (or a non-crypto-native) get comfortable:
//  • a first-launch welcome prompt that steers beginners to Paper practice or a tour
//  • a skippable guided coach-mark tour that points at the REAL on-screen elements
//  • a plain-language glossary (tap any jargon term → one-sentence explanation)
//  • a "Learn the basics" sheet reachable from the More menu
// Self-contained: it only touches the DOM and calls existing window.__* helpers, so it
// can't destabilise trading or account logic.

const LS_WELCOMED = 'hliq_onboard_welcomed_v1'
const LS_TOURDONE = 'hliq_onboard_tour_v1'

// ── Glossary ─────────────────────────────────────────────────────────────────
// [term, plain-English one-liner]. Deliberately jargon-free — written for someone
// who has never traded. Keys are lowercase-kebab.
// Each entry is bilingual: { en:[term, description], es:[term, description] }.
const GLOSSARY = {
  perps: {
    en: ['Perpetuals ("perps")', 'A way to bet on a coin going up or down without actually owning it — and with no expiry date. You hold the trade until you decide to close it.'],
    es: ['Perpetuos ("perps")', 'Una forma de apostar a que una moneda sube o baja sin poseerla — y sin fecha de vencimiento. Mantienes la operación hasta que decides cerrarla.'] },
  long: {
    en: ['Long', 'Betting the price goes UP. You profit if it rises, lose if it falls.'],
    es: ['Largo', 'Apostar a que el precio SUBE. Ganas si sube, pierdes si baja.'] },
  short: {
    en: ['Short', 'Betting the price goes DOWN. You profit if it falls, lose if it rises.'],
    es: ['Corto', 'Apostar a que el precio BAJA. Ganas si baja, pierdes si sube.'] },
  leverage: {
    en: ['Leverage', 'Trading bigger than your cash by borrowing. 10× means $100 controls $1,000 — your gains AND losses are 10 times bigger. High leverage is how accounts blow up fast, so start low.'],
    es: ['Apalancamiento', 'Operar por más de tu efectivo pidiendo prestado. 10× significa que $100 controlan $1,000 — tus ganancias Y pérdidas son 10 veces mayores. El apalancamiento alto revienta cuentas rápido, así que empieza bajo.'] },
  liquidation: {
    en: ['Liquidation', 'If a leveraged trade moves against you too far, the exchange force-closes it and you lose the margin you put in. The more leverage, the closer liquidation is.'],
    es: ['Liquidación', 'Si una operación apalancada se mueve demasiado en tu contra, el exchange la cierra a la fuerza y pierdes el margen que pusiste. A más apalancamiento, más cerca está la liquidación.'] },
  margin: {
    en: ['Margin', 'The cash you set aside to back a trade — your collateral. Lose more than this and you get liquidated.'],
    es: ['Margen', 'El efectivo que reservas para respaldar una operación — tu garantía. Si pierdes más que esto, te liquidan.'] },
  'mark-price': {
    en: ['Mark price', 'The fair current price the exchange uses to value your trade and decide liquidations. Not always the exact last trade price.'],
    es: ['Precio marca', 'El precio justo actual que el exchange usa para valorar tu operación y decidir liquidaciones. No siempre es el último precio operado exacto.'] },
  funding: {
    en: ['Funding', 'A small recurring payment between the up-betters and down-betters that keeps the perp price near the real price. You pay or receive it depending on your side.'],
    es: ['Financiamiento', 'Un pequeño pago recurrente entre quienes apuestan al alza y a la baja que mantiene el precio del perp cerca del precio real. Lo pagas o lo recibes según tu lado.'] },
  pnl: {
    en: ['PnL (Profit & Loss)', 'How much you\'ve made or lost. "Unrealized" = on trades still open (not locked in yet); "Realized" = from trades you\'ve already closed.'],
    es: ['PnL (Ganancias y Pérdidas)', 'Cuánto has ganado o perdido. "No realizado" = en operaciones aún abiertas (no asegurado todavía); "Realizado" = de operaciones que ya cerraste.'] },
  roe: {
    en: ['ROE', 'Return on Equity — your profit as a percentage of the margin you put in. With leverage this number moves fast in both directions.'],
    es: ['ROE', 'Retorno sobre el capital — tu ganancia como porcentaje del margen que pusiste. Con apalancamiento este número se mueve rápido en ambos sentidos.'] },
  spot: {
    en: ['Spot', 'Actually buying and owning the coin, as opposed to a leveraged perp bet.'],
    es: ['Spot', 'Comprar y poseer la moneda de verdad, a diferencia de una apuesta apalancada en perps.'] },
  'agent-key': {
    en: ['Agent key', 'A signing key that lets this app place your trades. It can trade but can NEVER withdraw your funds — see Security & Keys.'],
    es: ['Clave de agente', 'Una clave de firma que permite a esta app colocar tus operaciones. Puede operar pero NUNCA puede retirar tus fondos — ver Seguridad y claves.'] },
  'tp-sl': {
    en: ['Take Profit / Stop Loss', 'Automatic exits. Take Profit closes the trade once you\'ve gained enough; Stop Loss closes it to cap a loss.'],
    es: ['Tomar ganancias / Stop de pérdida', 'Salidas automáticas. Tomar ganancias cierra la operación cuando ya ganaste suficiente; Stop de pérdida la cierra para limitar una pérdida.'] },
  isolated: {
    en: ['Isolated vs Cross margin', 'Isolated: only the margin on THAT one trade is at risk. Cross: your whole balance backs every trade — more efficient, but one bad trade can drag it all down.'],
    es: ['Margen aislado vs cruzado', 'Aislado: solo el margen de ESA operación está en riesgo. Cruzado: todo tu saldo respalda cada operación — más eficiente, pero una mala operación puede arrastrarlo todo.'] },
  health: {
    en: ['Health', 'How far your account is from liquidation. High and green = safe; low and red = one bad move from being force-closed.'],
    es: ['Salud', 'Qué tan lejos está tu cuenta de la liquidación. Alta y verde = segura; baja y roja = a un mal movimiento de que la cierren a la fuerza.'] },
  withdrawable: {
    en: ['Free margin', 'Cash not currently backing a trade — what you could withdraw or use to open something new.'],
    es: ['Margen libre', 'Efectivo que no respalda ninguna operación — lo que podrías retirar o usar para abrir algo nuevo.'] },
}
// Resolve a glossary entry [term, description] for the active language.
const _g = k => { const e = GLOSSARY[k]; return e ? (e[_lang()] || e.en) : null }

// ── Small style helpers (inline; no CSS file changes) ──
const CARD = 'background:var(--panel-2,#1a1d24);border:1px solid var(--border2,#2a2e39);border-radius:16px'
const BTN  = 'border:none;border-radius:11px;padding:12px 16px;font-size:14px;font-weight:700;cursor:pointer'
const esc  = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Onboarding/help prose is heavy with inline <b> markup, so the runtime DOM dictionary can't
// translate it node-by-node. Instead these sheets are authored bilingually at the source and
// pick a language here. (Short UI labels still go through the ES_DICT in main.js.)
const _lang = () => { try { return (localStorage.getItem('hliq_lang') || 'en') === 'es' ? 'es' : 'en' } catch { return 'en' } }
const T = (en, es) => _lang() === 'es' ? es : en

// Render a glossary TERM label, keeping any quoted jargon abbreviation out of auto-translation.
// Google Translate reads "perps" as "perpetrators" and renders "delincuentes" (criminals); the
// same would mangle other trading shorthands. Wrapping the quoted token in .notranslate lets the
// surrounding word translate ("Perpetuals" → "Perpetuos") while the abbreviation stays verbatim.
const _glossTermHtml = label => esc(label).replace(/&quot;([^&]+?)&quot;/g, '&quot;<span class="notranslate">$1</span>&quot;')

// ── Glossary popover ─────────────────────────────────────────────────────────
window.__glossary = function(key) {
  const g = _g(key)
  if (!g) return
  _sheet(`<div style="font-size:17px;font-weight:800;margin-bottom:8px">${_glossTermHtml(g[0])}</div>
    <div style="font-size:14px;line-height:1.6;color:var(--fg-2,#c9cdd6)">${esc(g[1])}</div>
    <button onclick="window.__closeOnboardSheet()" style="${BTN};margin-top:16px;width:100%;background:var(--accent,#00e5a0);color:#000">${T('Got it', 'Entendido')}</button>`)
}

// A tappable jargon term. Usage in any template: ${__term('leverage','leverage')}
export function __term(label, key) {
  return `<span onclick="event.stopPropagation();window.__glossary('${key}')" style="border-bottom:1px dotted currentColor;cursor:pointer">${esc(label)}<sup style="font-size:.7em;color:var(--accent,#00e5a0);font-weight:700"> ?</sup></span>`
}
window.__term = __term

// ── "Learn the basics" full sheet ────────────────────────────────────────────
window.__openLearn = function() {
  const rows = Object.keys(GLOSSARY).map(k => { const g = _g(k)
    return `<div style="padding:12px 0;border-bottom:1px solid var(--border,#232733)">
       <div style="font-size:14px;font-weight:800;margin-bottom:3px">${_glossTermHtml(g[0])}</div>
       <div style="font-size:13px;line-height:1.55;color:var(--fg-2,#c9cdd6)">${esc(g[1])}</div>
     </div>` }).join('')
  _sheet(`<div style="font-size:18px;font-weight:800">${T('Learn the basics', 'Aprende lo básico')}</div>
    <div style="font-size:12.5px;color:var(--muted,#8a90a0);margin:4px 0 8px">${T('Plain-English, 30 seconds each. Nothing here is advice — trading is risky.', 'En lenguaje claro, 30 segundos cada uno. Nada aquí es consejo financiero — operar es arriesgado.')}</div>
    <button onclick="window.__closeOnboardSheet();window.__startMainTour(true)" style="${BTN};width:100%;background:rgba(0,229,160,0.14);color:var(--accent,#00e5a0);margin-bottom:6px">🧭 ${T('Take the guided tour', 'Hacer el recorrido guiado')}</button>
    <button onclick="window.__closeOnboardSheet();window.__goPaper&&window.__goPaper()" style="${BTN};width:100%;background:rgba(255,159,67,0.12);color:#ff9f43;margin-bottom:6px">🎓 ${T('Practice with fake money', 'Practicar con dinero ficticio')}</button>
    <button onclick="window.__closeOnboardSheet();window.__openFundGuide()" style="${BTN};width:100%;background:rgba(99,179,237,0.12);color:#63b3ed;margin-bottom:10px">💰 ${T('How to fund your account', 'Cómo financiar tu cuenta')}</button>
    ${rows}`, true)
}

// ── Report a Bug ─────────────────────────────────────────────────────────────
// Opens a short form; on send we attach lightweight diagnostics (no keys, no addresses)
// and POST to the notify server, which appends it to data/bug-reports.json. If the network
// call fails we fall back to copying the report so nothing the user typed is lost.
function _bugDiag() {
  let lang = 'en'
  try { lang = localStorage.getItem('hliq_lang') || 'en' } catch {}
  return {
    ts:     new Date().toISOString(),
    ua:     navigator.userAgent,
    screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
    lang,
    tab:    (typeof window._mobVActiveTab === 'string' ? window._mobVActiveTab : '') || '',
    url:    location.pathname + location.hash,
    paper:  (() => { try { return window.isPaper && window.isPaper() } catch { return false } })(),
  }
}
window.__openBugReport = function() {
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  _sheet(`<div style="font-size:18px;font-weight:800;margin-bottom:4px">${T('Report a bug', 'Informar un error')} 🐞</div>
    <div style="font-size:12.5px;color:var(--muted,#8a90a0);margin-bottom:12px">
      ${T('Insolvent is in early beta — thank you for helping. Tell us what happened (and what you expected).', 'Insolvent está en beta temprana — gracias por ayudar. Cuéntanos qué pasó (y qué esperabas).')}
    </div>
    <textarea id="bugReportText" placeholder="${esc(T('e.g. My positions tab showed the wrong language after I switched to Spanish…', 'ej. Mi pestaña de posiciones mostró el idioma equivocado tras cambiar a español…'))}"
      style="width:100%;min-height:120px;box-sizing:border-box;resize:vertical;padding:12px;border-radius:12px;border:1px solid var(--border2,#2a2e39);background:var(--panel,#12141a);color:var(--fg,#e8eaf0);font-size:14px;font-family:inherit;line-height:1.5"></textarea>
    <label style="display:flex;align-items:center;gap:8px;margin:10px 2px 4px;font-size:12.5px;color:var(--fg-2,#c9cdd6);cursor:pointer">
      <input type="checkbox" id="bugReportDiag" checked style="width:16px;height:16px;accent-color:var(--accent,#00e5a0)">
      ${T('Attach device info (browser, screen size, language) — no wallet or keys', 'Adjuntar info del dispositivo (navegador, tamaño de pantalla, idioma) — sin billetera ni claves')}
    </label>
    <div id="bugReportMsg" style="font-size:12.5px;min-height:16px;margin:6px 2px"></div>
    <button id="bugReportSend" onclick="window.__submitBugReport()" style="${BTN};width:100%;background:var(--accent,#00e5a0);color:#000">${T('Send report', 'Enviar reporte')}</button>
    <div style="font-size:11.5px;color:var(--muted,#8a90a0);text-align:center;margin-top:12px">
      ${T('Prefer to reach out directly?', '¿Prefieres contactar directamente?')} <a href="https://x.com/insolventPr" target="_blank" rel="noopener" style="color:var(--accent,#00e5a0);font-weight:700">@insolventPr</a>
    </div>`, true)
}
window.__submitBugReport = async function() {
  const ta  = document.getElementById('bugReportText')
  const msg = document.getElementById('bugReportMsg')
  const btn = document.getElementById('bugReportSend')
  const text = (ta?.value || '').trim()
  if (!text) { if (msg) { msg.style.color = '#ff9f43'; msg.textContent = T('Please describe the bug first.', 'Primero describe el error.') } ta?.focus(); return }
  const attach = document.getElementById('bugReportDiag')?.checked !== false
  const payload = { message: text.slice(0, 4000), diag: attach ? _bugDiag() : { ts: new Date().toISOString() } }
  if (btn) { btn.disabled = true; btn.textContent = T('Sending…', 'Enviando…') }
  try {
    const r = await fetch('/api/bug-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!r.ok) throw new Error('http ' + r.status)
    if (msg) { msg.style.color = 'var(--accent,#00e5a0)'; msg.textContent = T('✓ Thank you! Your report was sent.', '✓ ¡Gracias! Tu reporte fue enviado.') }
    if (ta) ta.value = ''
    if (btn) { btn.textContent = T('Sent ✓', 'Enviado ✓') }
    setTimeout(() => window.__closeOnboardSheet(), 1400)
  } catch (e) {
    // Network fallback — don't lose what they wrote: copy it so they can paste to @insolventPr.
    try { await navigator.clipboard.writeText(text + '\n\n' + JSON.stringify(payload.diag)) } catch {}
    if (msg) { msg.style.color = '#ff9f43'; msg.innerHTML = T("Couldn't reach the server — your report was copied. Please paste it to ", 'No se pudo contactar al servidor — tu reporte fue copiado. Pégalo en ') + "<a href='https://x.com/insolventPr' target='_blank' rel='noopener' style='color:var(--accent,#00e5a0)'>@insolventPr</a>." }
    if (btn) { btn.disabled = false; btn.textContent = T('Try again', 'Reintentar') }
  }
}

// ── Invite friends (shares the APP) ──────────────────────────────────────────
// Just the plain app link. HL referral + builder fee are applied automatically when a friend
// trades in the app (setReferrer('INSOLVENTSPARTAN') + approveBuilderFee), so nothing to track.
const APP_LINK = 'https://insolvent.trade'
window.__inviteShare = async function() {
  try { await navigator.share({ title: 'Insolvent', text: 'Trade Hyperliquid from your phone — start with fake money, no wallet needed.', url: APP_LINK }) } catch {}
}
window.__inviteCopy = async function(btn) {
  try { await navigator.clipboard.writeText(APP_LINK); const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = t }, 1500) }
  catch { alert(APP_LINK) }
}
window.__openInvite = function() {
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  const native = !!navigator.share
  _sheet(`<div style="font-size:19px;font-weight:800;margin-bottom:6px">${T('Invite friends', 'Invitar amigos')} 🎁</div>
    <div style="font-size:13.5px;line-height:1.6;color:var(--fg-2,#c9cdd6);margin-bottom:14px">
      ${T('Share Insolvent with a friend. They can start with fake money — no wallet needed — and trade Hyperliquid right from their phone.', 'Comparte Insolvent con un amigo. Puede empezar con dinero ficticio — sin billetera — y operar en Hyperliquid desde su teléfono.')}
    </div>
    <div style="display:flex;align-items:center;background:var(--panel,#12141a);border:1px solid var(--border2,#2a2e39);border-radius:12px;padding:11px 13px;margin-bottom:12px">
      <span class="notranslate" style="flex:1;min-width:0;font-size:13px;font-family:var(--font-mono,monospace);color:var(--fg-2,#c9cdd6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(APP_LINK)}</span>
    </div>
    ${native ? `<button onclick="window.__inviteShare()" style="${BTN};width:100%;background:var(--accent,#00e5a0);color:#000;margin-bottom:8px">↗ ${T('Share invite', 'Compartir invitación')}</button>` : ''}
    <button onclick="window.__inviteCopy(this)" style="${BTN};width:100%;background:${native ? 'rgba(0,229,160,0.12);color:var(--accent,#00e5a0)' : 'var(--accent,#00e5a0);color:#000'}">${T('Copy link', 'Copiar enlace')}</button>`)
}

// ── "Fund your account" guide (walletless → trading) ─────────────────────────
window.__openFundGuide = function() {
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  const step = (n, title, body) => `<div style="display:flex;gap:12px;margin-bottom:15px">
      <div style="flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--accent,#00e5a0);color:#000;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center">${n}</div>
      <div style="flex:1"><div style="font-size:14.5px;font-weight:800;margin-bottom:3px">${title}</div>
        <div style="font-size:13px;line-height:1.55;color:var(--fg-2,#c9cdd6)">${body}</div></div>
    </div>`
  _sheet(`<div style="font-size:19px;font-weight:800;margin-bottom:4px">${T('Fund your account', 'Financia tu cuenta')} 💰</div>
    <div style="font-size:12.5px;color:var(--muted,#8a90a0);margin-bottom:16px">${T("Starting from zero? Here's the path to real trading. No rush — you can practice free in Paper mode first.", '¿Empiezas de cero? Este es el camino al trading real. Sin prisa — primero puedes practicar gratis en modo Práctica.')}</div>
    ${step(1, T('Get a crypto wallet', 'Consigue una billetera cripto'), T('Install a self-custody wallet — <b>Rabby</b> or <b>MetaMask</b> on desktop, or a mobile wallet app. It holds your funds and only you control it.', 'Instala una billetera de autocustodia — <b>Rabby</b> o <b>MetaMask</b> en escritorio, o una app de billetera móvil. Guarda tus fondos y solo tú la controlas.'))}
    ${step(2, T('Get USDC on Arbitrum', 'Consigue USDC en Arbitrum'), T('Buy <b>USDC</b> on any exchange (Coinbase, Binance, Kraken…) and <b>withdraw it to the Arbitrum network</b>. ⚠️ Make sure the network is <b>Arbitrum One</b> — sending to the wrong network can lose funds.', 'Compra <b>USDC</b> en cualquier exchange (Coinbase, Binance, Kraken…) y <b>retíralo a la red Arbitrum</b>. ⚠️ Asegúrate de que la red sea <b>Arbitrum One</b> — enviar a la red equivocada puede perder fondos.'))}
    ${step(3, T('Deposit into Hyperliquid', 'Deposita en Hyperliquid'), T('Connect your wallet here, tap <b>Deposit</b>, and move your USDC in. Your first deposit creates your Hyperliquid account automatically.', 'Conecta tu billetera aquí, toca <b>Depositar</b> y mueve tu USDC. Tu primer depósito crea tu cuenta de Hyperliquid automáticamente.'))}
    ${step(4, T('Start small', 'Empieza en pequeño'), T('Trade small with low leverage while you learn. High leverage is how accounts blow up fast.', 'Opera en pequeño y con poco apalancamiento mientras aprendes. El apalancamiento alto revienta cuentas rápido.'))}
    <button onclick="window.__closeOnboardSheet();window.__goPaper&&window.__goPaper()" style="${BTN};width:100%;background:rgba(255,159,67,0.12);color:#ff9f43;margin-top:2px">🎓 ${T('Practice free with fake money first', 'Practica gratis con dinero ficticio primero')}</button>
    <div style="font-size:11px;color:var(--muted,#8a90a0);text-align:center;margin-top:12px;line-height:1.5">${T('Insolvent never holds your funds — they stay in your own wallet and Hyperliquid account.', 'Insolvent nunca guarda tus fondos — permanecen en tu propia billetera y cuenta de Hyperliquid.')}</div>`, true)
}

// ── Bottom-sheet primitive ───────────────────────────────────────────────────
function _sheet(innerHtml, scroll = false) {
  window.__closeOnboardSheet()
  const ov = document.createElement('div')
  ov.id = 'onboardSheet'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100060;background:rgba(0,0,0,.55);display:flex;flex-direction:column;justify-content:flex-end'
  ov.onclick = e => { if (e.target === ov) window.__closeOnboardSheet() }
  ov.innerHTML = `<div style="${CARD};border-radius:20px 20px 0 0;padding:20px 18px calc(22px + env(safe-area-inset-bottom));max-height:82vh;${scroll ? 'overflow-y:auto' : ''}">
    <div style="width:38px;height:4px;border-radius:2px;background:var(--border2,#2a2e39);margin:-6px auto 14px"></div>
    ${innerHtml}
  </div>`
  document.body.appendChild(ov)
  try { window.__i18nApply && window.__i18nApply() } catch {}
}
window.__closeOnboardSheet = function() { document.getElementById('onboardSheet')?.remove() }

// ── Coach-mark guided tour ───────────────────────────────────────────────────
// Steps: { sel?, title, body }. A step with no sel is a centered card (intro/outro).
let _steps = [], _idx = 0
function _tourSteps() {
  return [
    { title: 'Welcome to Insolvent 👋', body: 'A 30-second tour of the essentials. You can skip anytime. Nothing you do in a tour touches real money.' },
    { sel: '.mob-v-equity-card,#mobVBalance', title: 'Your account value', body: 'Everything you hold, combined, in one number. The bar under it is your <b>Health</b> — how far you are from being force-closed.' },
    { sel: '.mob-v-actions', title: 'Add or move funds', body: 'Deposit to start, withdraw anytime. Your funds live on Hyperliquid — this app can trade them but can never take them.' },
    { sel: '.mob-v-bottom-trade,[data-tab="trade"]', title: 'Place a trade', body: 'Tap here to buy (go up) or sell (go down). Start small and with low leverage — tap any “?” to learn a term first.' },
    { sel: '#mobVTab-positions,[data-tab="positions"]', title: 'Your open trades', body: 'Anything you\'ve opened shows here with its live profit/loss and how close it is to liquidation.' },
    { sel: '#mobVBotMore,#mobNav .mob-nav-btn:last-child', title: 'Everything else', body: 'History, settings, Security & Keys, and this tour again live in the More menu.' },
    { title: 'Try it risk-free first 🎓', body: 'New to this? Start in <b>Paper mode</b> — trade with fake money to get the feel before risking a cent.', cta: ['Practice with fake money', "window.__closeTour();window.__goPaper&&window.__goPaper()"] },
  ]
}
window.__startMainTour = function(force) {
  if (!force && localStorage.getItem(LS_TOURDONE)) return
  // The tour highlights elements on the HOME screen, so first close whatever's covering it —
  // the More drawer (which is how you get to Help & Learn) or any open sheet — and return to
  // home. Then wait a beat for the close animation so element rects measure correctly.
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  window.__closeOnboardSheet()
  try { window.mobVHome && window.mobVHome() } catch {}
  _steps = _tourSteps(); _idx = 0
  try { localStorage.setItem(LS_TOURDONE, '1') } catch {}
  setTimeout(_renderStep, 280)
}
window.__tourNext = function() { _idx++; (_idx >= _steps.length) ? window.__closeTour() : _renderStep() }
window.__tourPrev = function() { if (_idx > 0) { _idx--; _renderStep() } }
window.__closeTour = function() { document.getElementById('onboardTour')?.remove() }

function _findTarget(sel) {
  // Pick the first VISIBLE match — a comma selector may match a hidden duplicate
  // (e.g. the advanced-mode nav) that would give a 0×0 rect and draw no spotlight.
  if (!sel) return null
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return document.querySelector(sel)
}

function _renderStep() {
  const step = _steps[_idx]
  if (!step) return
  const target = _findTarget(step.sel)
  // If the target isn't fully on screen, scroll it in FIRST, then draw after the
  // scroll settles — the spotlight is fixed-positioned, so drawing before a scroll
  // would leave it stuck at the element's old coordinates (it'd point at the wrong row).
  if (target) {
    const r = target.getBoundingClientRect()
    const off = r.top < 8 || r.bottom > window.innerHeight - 8
    if (off) {
      document.getElementById('onboardTour')?.remove()
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {}
      setTimeout(() => _paintStep(step, _findTarget(step.sel)), 320)
      return
    }
  }
  _paintStep(step, target)
}

function _paintStep(step, target) {
  document.getElementById('onboardTour')?.remove()
  const rect = target ? target.getBoundingClientRect() : null
  const ov = document.createElement('div')
  ov.id = 'onboardTour'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100055'

  // Spotlight: a transparent box over the target with a huge dim shadow everywhere else.
  let spot = ''
  if (rect && rect.width > 0 && rect.height > 0) {
    const pad = 6
    spot = `<div style="position:fixed;left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.72);border:2px solid var(--accent,#00e5a0);transition:all .2s;pointer-events:none"></div>`
  } else {
    spot = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.72)"></div>`
  }

  // Tooltip card: below the target if there's room, else above; centered when no target.
  const total = _steps.length
  const dots = _steps.map((_, i) => `<span style="width:6px;height:6px;border-radius:50%;background:${i === _idx ? 'var(--accent,#00e5a0)' : 'var(--border2,#2a2e39)'}"></span>`).join('')
  const cta = step.cta ? `<button onclick="${step.cta[1]}" style="${BTN};width:100%;background:rgba(255,159,67,0.14);color:#ff9f43;margin-bottom:8px">${esc(step.cta[0])}</button>` : ''
  const card = `<div style="${CARD};padding:16px;box-shadow:0 8px 30px rgba(0,0,0,.5)">
    <div style="font-size:16px;font-weight:800;margin-bottom:6px">${step.title}</div>
    <div style="font-size:13.5px;line-height:1.55;color:var(--fg-2,#c9cdd6)">${step.body}</div>
    ${cta}
    <div style="display:flex;align-items:center;gap:8px;margin-top:14px">
      <div style="display:flex;gap:5px;flex:1">${dots}</div>
      ${_idx > 0 ? `<button onclick="window.__tourPrev()" style="${BTN};background:transparent;color:var(--muted,#8a90a0);padding:8px 10px">Back</button>` : ''}
      <button onclick="window.__closeTour()" style="${BTN};background:transparent;color:var(--muted,#8a90a0);padding:8px 10px">Skip</button>
      <button onclick="window.__tourNext()" style="${BTN};background:var(--accent,#00e5a0);color:#000;padding:8px 16px">${_idx === total - 1 ? 'Done' : 'Next'}</button>
    </div>
  </div>`

  let pos
  if (rect && rect.width > 0) {
    const below = rect.bottom + 12
    const spaceBelow = window.innerHeight - rect.bottom
    if (spaceBelow > 210) pos = `left:12px;right:12px;top:${below}px`
    else pos = `left:12px;right:12px;bottom:${window.innerHeight - rect.top + 12}px`
  } else {
    pos = 'left:12px;right:12px;top:50%;transform:translateY(-50%)'
  }
  ov.innerHTML = spot + `<div style="position:fixed;${pos};max-width:440px;margin:0 auto">${card}</div>`
  ov.onclick = e => { if (e.target === ov) { /* ignore backdrop taps so a mis-tap doesn't dismiss */ } }
  document.body.appendChild(ov)
}

// ── First-launch welcome ─────────────────────────────────────────────────────
// Shown once, only in the mobile view, after the dashboard is on screen (so tour
// targets exist). Non-blocking: a bottom card offering practice / tour / dismiss.
window.__maybeWelcome = function() {
  if (localStorage.getItem(LS_WELCOMED)) return
  // Don't stack on the language chooser or the announcement — show on the next open instead.
  if (document.getElementById('langChooseModal') || document.getElementById('annModal')) return
  if (!document.querySelector('#mobNav')) return
  if (window.innerWidth > 768) { try { localStorage.setItem(LS_WELCOMED, '1') } catch {}; return } // desktop: skip for now
  try { localStorage.setItem(LS_WELCOMED, '1') } catch {}
  _sheet(`<div style="font-size:19px;font-weight:800;margin-bottom:6px">${T('Welcome', 'Bienvenido')} 👋</div>
    <div style="font-size:14px;line-height:1.6;color:var(--fg-2,#c9cdd6);margin-bottom:16px">
      ${T('Insolvent lets you trade Hyperliquid from your phone. New to this? Start by practicing with fake money — no wallet, no risk — or take a quick tour.', 'Insolvent te permite operar en Hyperliquid desde tu teléfono. ¿Eres nuevo? Empieza practicando con dinero ficticio — sin billetera, sin riesgo — o haz un recorrido rápido.')}
    </div>
    <button onclick="window.__closeOnboardSheet();window.__goPaper&&window.__goPaper()" style="${BTN};width:100%;background:var(--accent,#00e5a0);color:#000;margin-bottom:8px">🎓 ${T('Practice with fake money', 'Practicar con dinero ficticio')}</button>
    <button onclick="window.__closeOnboardSheet();setTimeout(()=>window.__startMainTour(true),350)" style="${BTN};width:100%;background:rgba(0,229,160,0.12);color:var(--accent,#00e5a0);margin-bottom:8px">🧭 ${T('Take the 30-second tour', 'Hacer el recorrido de 30 segundos')}</button>
    <button onclick="window.__closeOnboardSheet()" style="${BTN};width:100%;background:transparent;color:var(--muted,#8a90a0)">${T("I've got this →", 'Ya entendí →')}</button>`)
}

// ── "Add to Home Screen" install nudge ───────────────────────────────────────
// A mobile-first PWA lives on the home screen. Capture the install prompt (Android/Chrome)
// and offer a one-time, dismissible nudge; on iOS Safari (no prompt event) show the manual
// Share → Add to Home Screen steps. Never shown once installed.
const LS_INSTALL = 'hliq_install_nudge_v2'
let _deferredInstall = null
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _deferredInstall = e })
window.addEventListener('appinstalled', () => { try { localStorage.setItem(LS_INSTALL, '1') } catch {}; window.__closeOnboardSheet() })

const _isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
const _isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream

window.__installApp = async function() {
  if (!_deferredInstall) return
  window.__closeOnboardSheet()
  try { _deferredInstall.prompt(); await _deferredInstall.userChoice } catch {}
  _deferredInstall = null
  try { localStorage.setItem(LS_INSTALL, '1') } catch {}
}

window.__maybeInstallNudge = function() {
  try { if (localStorage.getItem(LS_INSTALL)) return } catch {}
  if (_isStandalone()) return                 // already installed
  if (window.innerWidth > 768) return          // mobile-first nudge
  if (!document.querySelector('#mobNav')) return
  const ios = _isIOS()
  if (!_deferredInstall && !ios) return         // no installable path in this browser
  try { localStorage.setItem(LS_INSTALL, '1') } catch {}
  const body = ios
    ? `<div style="font-size:14px;line-height:1.6;color:var(--fg-2,#c9cdd6);margin-bottom:16px">
         ${T('Add Insolvent to your Home Screen for a full-screen, app-like experience:', 'Agrega Insolvent a tu pantalla de inicio para una experiencia de pantalla completa como app:')}
         <div style="margin-top:10px;padding:12px 14px;background:var(--panel,#12141a);border-radius:12px;font-size:13.5px">
           ${T('1. Tap the <b>Share</b> button', '1. Toca el botón <b>Compartir</b>')} <span style="opacity:.7">${T('(the □ with an ↑)', '(el □ con una ↑)')}</span><br>
           ${T('2. Choose <b>Add to Home Screen</b>', '2. Elige <b>Agregar a inicio</b>')}
         </div>
       </div>
       <button onclick="window.__closeOnboardSheet()" style="${BTN};width:100%;background:var(--accent,#00e5a0);color:#000">${T('Got it', 'Entendido')}</button>`
    : `<div style="font-size:14px;line-height:1.6;color:var(--fg-2,#c9cdd6);margin-bottom:16px">
         ${T('Install Insolvent for a full-screen, app-like experience — it opens straight from your home screen, no browser bars.', 'Instala Insolvent para una experiencia de pantalla completa como app — se abre directo desde tu pantalla de inicio, sin barras del navegador.')}
       </div>
       <button onclick="window.__installApp()" style="${BTN};width:100%;background:var(--accent,#00e5a0);color:#000;margin-bottom:8px">📲 ${T('Add to Home Screen', 'Agregar a inicio')}</button>
       <button onclick="window.__closeOnboardSheet()" style="${BTN};width:100%;background:transparent;color:var(--muted,#8a90a0)">${T('Maybe later', 'Quizás luego')}</button>`
  _sheet(`<div style="font-size:19px;font-weight:800;margin-bottom:6px">${T('Install the app', 'Instala la app')} 📲</div>${body}`)
}

// ── App announcements ────────────────────────────────────────────────────────
// A modal shown on app open. Each announcement has an id; once the user closes it (the ✕,
// the CTA, or "Maybe later") the id is saved to `hliq_ann_dismissed` and it NEVER shows
// again. Optional `expires` (epoch ms) auto-hides it after a date even if never opened.
// Content is authored per-language (en/es) and the card is `.notranslate` — the DOM i18n
// walker leaves it alone since it's already localized. Add new items to the top of the list.
const LS_ANN = 'hliq_ann_dismissed'
// Challenge hidden 2026-08-10 (per request). Restore the object below to re-enable the
// on-open announcement; the Challenge entry points (More-drawer button, __openChallenge)
// are also hidden. Keeping the data here so it's a one-line revert.
const ANNOUNCEMENTS = [
  // {
  //   id: 'challenge-100usdc',
  //   emoji: '🏆',
  //   expires: Date.parse('2026-09-01T00:00:00Z'),
  //   tag:   { en: 'New', es: 'Nuevo' },
  //   title: { en: 'Win $100 USDC', es: 'Gana $100 USDC' },
  //   body:  {
  //     en: 'Everyone starts with <b>$1,000</b> in paper money — no deposits, no risk. The trader with the <b>highest net PnL wins $100 USDC</b>. Practice, climb the leaderboard, win real money.',
  //     es: 'Todos empiezan con <b>$1,000</b> en dinero de práctica — sin depósitos, sin riesgo. Quien tenga el <b>mayor PnL neto gana $100 USDC</b>. Practica, sube en la clasificación y gana dinero real.',
  //   },
  //   cta:   { label: { en: '🚀 Enter the challenge', es: '🚀 Entrar al desafío' }, action: 'window.__openChallenge()' },
  //   later: { en: 'Maybe later', es: 'Quizás luego' },
  // },
]

function _annLang() { let l = 'en'; try { l = localStorage.getItem('hliq_lang') || 'en' } catch {}; return l === 'es' ? 'es' : 'en' }
function _annDismissed() { try { return new Set(JSON.parse(localStorage.getItem(LS_ANN) || '[]')) } catch { return new Set() } }
function _annDismiss(id) { try { const s = _annDismissed(); s.add(id); localStorage.setItem(LS_ANN, JSON.stringify([...s])) } catch {} }
window.__closeAnnouncement = function(id) { if (id) _annDismiss(id); document.getElementById('annModal')?.remove() }

// Show the first not-yet-dismissed, not-expired announcement. No-op if a sheet/modal is
// already open, so it never stacks on the welcome/install/challenge UI.
window.__showAnnouncements = function() {
  if (document.getElementById('onboardSheet') || document.getElementById('annModal') || document.getElementById('langChooseModal')) return
  const dismissed = _annDismissed(), now = Date.now()
  const a = ANNOUNCEMENTS.find(x => !dismissed.has(x.id) && (!x.expires || x.expires > now))
  if (!a) return
  const L = _annLang(), pick = f => (f && (f[L] ?? f.en)) || ''
  const idJs = a.id.replace(/'/g, "\\'")
  const ctaBtn = a.cta ? `<button onclick="window.__closeAnnouncement('${idJs}');${a.cta.action}" style="${BTN};width:100%;background:var(--accent,#00e5a0);color:#000;margin-bottom:6px">${esc(pick(a.cta.label))}</button>` : ''
  const ov = document.createElement('div')
  ov.id = 'annModal'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100055;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px'
  ov.onclick = e => { if (e.target === ov) window.__closeAnnouncement(idJs) }
  ov.innerHTML = `<div class="notranslate" style="${CARD};position:relative;max-width:360px;width:100%;padding:26px 22px 20px;border-radius:20px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)">
      <button aria-label="Close" onclick="window.__closeAnnouncement('${idJs}')" style="position:absolute;top:12px;right:12px;width:30px;height:30px;border:none;border-radius:50%;background:var(--panel,#12141a);color:var(--muted,#8a90a0);font-size:16px;line-height:1;cursor:pointer">✕</button>
      ${a.tag ? `<div style="display:inline-block;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--accent,#00e5a0);background:rgba(0,229,160,.12);padding:3px 10px;border-radius:20px;margin-bottom:12px">${esc(pick(a.tag))}</div>` : ''}
      <div style="font-size:46px;line-height:1;margin-bottom:10px">${a.emoji}</div>
      <div style="font-size:22px;font-weight:800;margin-bottom:8px">${esc(pick(a.title))}</div>
      <div style="font-size:13.5px;line-height:1.6;color:var(--fg-2,#c9cdd6);margin-bottom:18px">${pick(a.body)}</div>
      ${ctaBtn}
      <button onclick="window.__closeAnnouncement('${idJs}')" style="${BTN};width:100%;background:transparent;color:var(--muted,#8a90a0)">${esc(pick(a.later))}</button>
    </div>`
  document.body.appendChild(ov)
}

// ── First-open language chooser ──────────────────────────────────────────────
// A one-time modal that asks the user to pick a language BEFORE anything else, so the
// announcement (and the whole app) render in their choice. Persisted like an announcement:
// once a language is picked (or the modal dismissed) it never shows again. `onDone` runs
// after the choice is applied (with a beat for Spanish to translate) so the caller can then
// show the announcement in the chosen language.
const LS_LANG_CHOSEN = 'hliq_lang_chosen'
window.__pickLang = null
window.__maybeLangPicker = function(onDone) {
  const finish = (() => { let done = false; return () => { if (!done) { done = true; try { (onDone || (() => {}))() } catch {} } } })()
  let chosen = false; try { chosen = !!localStorage.getItem(LS_LANG_CHOSEN) } catch {}
  if (chosen || document.getElementById('langChooseModal') || document.getElementById('onboardSheet')) { finish(); return }

  const cur = _lang()
  window.__pickLang = function(lc) {
    try { localStorage.setItem(LS_LANG_CHOSEN, '1') } catch {}
    try { (window.__setLangMob || window.__setLang)?.(lc) } catch {}
    document.getElementById('langChooseModal')?.remove()
    // Give the ES DOM-walk a beat to land before the announcement paints (EN is instant).
    setTimeout(finish, lc === 'es' ? 380 : 0)
  }
  const opt = (lc, name, native) => `<button onclick="window.__pickLang('${lc}')"
      style="display:flex;align-items:center;justify-content:center;gap:9px;width:100%;padding:15px;border-radius:13px;border:1px solid ${cur === lc ? 'var(--accent,#00e5a0)' : 'var(--border2,#2a2e39)'};background:${cur === lc ? 'rgba(0,229,160,.12)' : 'var(--panel,#12141a)'};color:var(--fg,#e8eaf0);font-size:16px;font-weight:800;cursor:pointer;margin-bottom:10px">
      ${native}<span style="font-size:12px;font-weight:600;color:var(--muted,#8a90a0)">${name}</span></button>`
  const ov = document.createElement('div')
  ov.id = 'langChooseModal'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100062;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:20px'
  ov.onclick = e => { if (e.target === ov) window.__pickLang(cur) }   // dismiss = keep current + persist
  ov.innerHTML = `<div class="notranslate" style="${CARD};max-width:340px;width:100%;padding:26px 22px 20px;border-radius:20px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)">
      <div style="font-size:42px;line-height:1;margin-bottom:10px">🌐</div>
      <div style="font-size:20px;font-weight:800;margin-bottom:4px">Choose your language</div>
      <div style="font-size:14px;color:var(--muted,#8a90a0);margin-bottom:18px">Elige tu idioma</div>
      ${opt('en', 'English', 'English')}
      ${opt('es', 'Spanish', 'Español')}
    </div>`
  document.body.appendChild(ov)
}

export function initOnboarding() {
  // 1) Language chooser FIRST (once), then the announcement so it shows in the chosen language.
  setTimeout(() => {
    try { window.__maybeLangPicker(() => { setTimeout(() => { try { window.__showAnnouncements() } catch {} }, 300) }) } catch {}
  }, 900)
  // Nudge the welcome shortly after load so the shell has rendered (skipped while the
  // language chooser is still open — its guard prevents stacking).
  setTimeout(() => { try { if (!document.getElementById('langChooseModal')) window.__maybeWelcome() } catch {} }, 2500)
  // Fallback announcement for users who already chose a language (no-ops if already shown
  // or if a sheet/chooser is still open).
  setTimeout(() => { try { window.__showAnnouncements() } catch {} }, 3200)
  // Later (and only on a return visit, so it never stacks on the welcome), offer install.
  setTimeout(() => {
    try {
      if (!localStorage.getItem(LS_WELCOMED)) return           // first-ever launch → welcome owns the moment
      if (document.getElementById('onboardSheet') || document.getElementById('annModal') || document.getElementById('langChooseModal')) return  // don't cover an open sheet/announcement
      window.__maybeInstallNudge()
    } catch {}
  }, 22000)
}
