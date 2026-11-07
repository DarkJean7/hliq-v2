// What opens under a row of Macro's "Coming up": what the report is, the published estimate for it, what a
// surprise tends to do, and how Bitcoin actually moved on the last year's report days.
//
// Estimates are from public institutions and are labelled as such. Reports with none say so: an empty
// section is not a forecast of "nothing". The conditional language ("tends to", "often") is deliberate,
// because markets regularly do the opposite and each of these sentences has counterexamples.

const shiftMonth = (date, n = 1) => {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)
}
const monthName = (ym) => new Date(ym + '-15T12:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortDay = (d) => new Date(d * 864e5).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })
const pct = (v, dp = 1) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp) + '%'
const spct = (v, dp = 1) => v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp) + '%'
const money = (n) => { const a = Math.abs(n); return '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0)) }

const H = 'font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:13px 0 5px'
const P = 'font-size:12px;line-height:1.55;color:var(--fg-2);margin:0'
const SMALL = 'font-size:10.5px;color:var(--fg-3);line-height:1.5;margin-top:6px'

function copy(T) {
  const everyday = {
    infl: T('Prices you pay, and the interest on loans and savings, all tend to follow the path this sets.', 'Los precios que pagas y el interés de préstamos y ahorros suelen seguir el camino que esto marca.'),
    jobs: T('Job security and pay growth first, then interest rates, because the Fed watches this closely.', 'Primero la seguridad laboral y los salarios, y después los tipos de interés, porque la Fed lo vigila de cerca.'),
  }
  return {
    cpi: {
      what: T('How much a basket of everyday goods and services costs, measured against last month and last year. It is the most closely watched inflation report and often the biggest scheduled market event of its month.', 'Cuánto cuesta una cesta de bienes y servicios, frente al mes y al año anteriores. Es el informe de inflación más seguido y a menudo el mayor evento programado del mes.'),
      up: [T('Higher than expected', 'Más alto de lo esperado'), T('Rate cuts look further away, or hikes closer. Crypto and stocks have often fallen and the dollar risen.', 'Los recortes de tipos se alejan, o las subidas se acercan. Cripto y bolsa han caído a menudo y el dólar ha subido.')],
      down: [T('Lower than expected', 'Más bajo de lo esperado'), T('Rate cuts look closer. Crypto and stocks have often risen and the dollar fallen.', 'Los recortes se acercan. Cripto y bolsa han subido a menudo y el dólar ha caído.')],
      everyday: everyday.infl,
    },
    ppi: {
      what: T('What businesses receive for what they sell. Higher costs here can reach consumer prices later, though companies sometimes absorb them instead.', 'Lo que reciben las empresas por lo que venden. Unos costes más altos pueden llegar después al consumidor, aunque a veces las empresas los absorben.'),
      up: [T('Higher than expected', 'Más alto de lo esperado'), T('Reads as inflation still in the pipeline. Usually a smaller market reaction than CPI.', 'Se lee como inflación aún en camino. Suele mover el mercado menos que el IPC.')],
      down: [T('Lower than expected', 'Más bajo de lo esperado'), T('Less cost pressure ahead, which supports the case for lower rates.', 'Menos presión de costes por delante, lo que apoya unos tipos más bajos.')],
      everyday: everyday.infl,
    },
    pce: {
      what: T('The Fed\'s preferred inflation measure, the one its 2% target refers to. It also reports household income and spending. Much of it can be worked out from CPI and PPI, so it often surprises less.', 'La medida de inflación preferida por la Fed, a la que se refiere su objetivo del 2%. También informa de ingresos y gasto de los hogares. Gran parte se puede deducir del IPC y el PPI, así que suele sorprender menos.'),
      up: [T('Higher than expected', 'Más alto de lo esperado'), T('Gives the Fed a reason to keep rates higher for longer.', 'Da a la Fed un motivo para mantener los tipos altos durante más tiempo.')],
      down: [T('Lower than expected', 'Más bajo de lo esperado'), T('Gives the Fed more room to cut.', 'Da a la Fed más margen para recortar.')],
      everyday: everyday.infl,
    },
    jobs: {
      what: T('The month\'s jobs added, the unemployment rate and wage growth. Out on the first Friday of most months, and one of the largest scheduled market movers. The jobs figure is often revised later.', 'Los empleos creados en el mes, la tasa de desempleo y los salarios. Sale el primer viernes de casi todos los meses y es de los que más mueven el mercado. La cifra de empleo suele revisarse después.'),
      up: [T('Stronger than expected', 'Más fuerte de lo esperado'), T('A healthy economy, but the Fed has less reason to cut. Markets can fall on this "good" news, particularly while inflation is high.', 'Economía sana, pero la Fed tiene menos motivos para recortar. El mercado puede caer con esta "buena" noticia, sobre todo con la inflación alta.')],
      down: [T('Weaker than expected', 'Más débil de lo esperado'), T('Rate cuts look closer, which markets can like. If it is weak enough to suggest recession, that fear can win instead.', 'Los recortes se acercan, y eso puede gustar al mercado. Si es tan débil que sugiere recesión, ese miedo puede imponerse.')],
      everyday: everyday.jobs,
    },
    jolts: {
      what: T('How many jobs employers are trying to fill, and how many people quit or were laid off. It describes the same labour market as the jobs report, about two months later.', 'Cuántos puestos intentan cubrir las empresas, y cuánta gente renuncia o es despedida. Describe el mismo mercado laboral que el informe de empleo, unos dos meses después.'),
      up: [T('More openings than expected', 'Más vacantes de lo esperado'), T('A tight labour market, which can keep wages and rates up.', 'Un mercado laboral ajustado, que puede mantener altos los salarios y los tipos.')],
      down: [T('Fewer openings than expected', 'Menos vacantes de lo esperado'), T('Hiring is cooling, which eases the pressure on wages and rates.', 'La contratación se enfría, lo que alivia la presión sobre salarios y tipos.')],
      everyday: everyday.jobs,
    },
    gdp: {
      what: T('How fast the US economy grew, adjusted for inflation and stated as a yearly pace. Each quarter gets three estimates, and later ones usually change the figure only a little.', 'A qué ritmo creció la economía de EE. UU., ajustado por inflación y en ritmo anual. Cada trimestre tiene tres estimaciones, y las posteriores suelen cambiar poco la cifra.'),
      up: [T('Revised higher', 'Revisado al alza'), T('A stronger economy, which supports company earnings but can keep rates higher.', 'Una economía más fuerte, que apoya los beneficios de las empresas pero puede mantener altos los tipos.')],
      down: [T('Revised lower', 'Revisado a la baja'), T('Slower growth, which can bring cuts closer or raise recession worries.', 'Menor crecimiento, que puede acercar los recortes o aumentar el temor a una recesión.')],
      everyday: T('Growth feeds through to hiring, pay and how companies invest, slowly and unevenly.', 'El crecimiento llega al empleo, los salarios y la inversión de las empresas, despacio y de forma desigual.'),
    },
    fomc: {
      what: T('The Fed sets its interest rate, then explains why. The chair\'s press conference 30 minutes later often moves markets more than the decision itself. A meeting "with projections" also publishes officials\' own forecasts for rates, inflation and growth.', 'La Fed fija su tipo de interés y explica por qué. La rueda de prensa del presidente, 30 minutos después, suele mover el mercado más que la propia decisión. Una reunión "con proyecciones" publica además las previsiones de los miembros para tipos, inflación y crecimiento.'),
      up: [T('A hike, or a tougher tone', 'Una subida, o un tono más duro'), T('Holding cash and bonds pays more, so riskier assets such as crypto have often fallen.', 'Mantener efectivo y bonos paga más, así que activos de riesgo como las cripto han caído a menudo.')],
      down: [T('A cut, or a softer tone', 'Un recorte, o un tono más suave'), T('Cheaper money has tended to help riskier assets, unless the cut signals the economy is in trouble.', 'El dinero más barato ha tendido a ayudar a los activos de riesgo, salvo que el recorte indique problemas en la economía.')],
      everyday: T('Credit cards, car loans and savings rates tend to follow within weeks. Mortgages follow longer-term yields, so they move less directly.', 'Tarjetas, préstamos de coche y tipos de ahorro suelen seguir en semanas. Las hipotecas siguen a los bonos a largo plazo, así que se mueven de forma menos directa.'),
    },
  }
}

function table(rows, heads) {
  const cell = (s, right = true, strong = false) => `<div style="${right ? 'text-align:right;font-family:var(--font-mono);' : ''}font-size:12px;${strong ? 'font-weight:800;color:var(--fg)' : 'color:var(--fg-2)'}">${s}</div>`
  const head = (s, right = true) => `<div style="${right ? 'text-align:right;' : ''}font-size:10px;color:var(--muted)">${s}</div>`
  return `<div data-ev-table style="display:grid;grid-template-columns:1fr auto auto;gap:5px 14px;align-items:baseline">
    ${head('', false)}${head(heads[0])}${head(heads[1])}
    ${rows.map(([l, a, b]) => cell(l, false) + cell(a, true, true) + cell(b)).join('')}
  </div>`
}

function estimateHtml(kind, d, deps) {
  const { T, esc } = deps
  const by = Object.fromEntries((d.items ?? []).map(i => [i.key, i]))
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const nowcast = (a, b) => {
    const ref = by[a]?.date
    const period = ref ? shiftMonth(ref) : null
    const n = period ? d.nowcast?.periods?.[period] : null
    if (!n || n.y?.[a] == null && n.m?.[a] == null) return null
    const miss = d.nowcast?.miss?.m?.[a]
    const rows = [
      [T(a === 'cpi' ? 'CPI, yearly' : 'PCE, yearly', a === 'cpi' ? 'IPC, anual' : 'PCE, anual'), pct(n.y?.[a]), pct(by[a]?.value)],
      [T(a === 'cpi' ? 'CPI, monthly' : 'PCE, monthly', a === 'cpi' ? 'IPC, mensual' : 'PCE, mensual'), spct(n.m?.[a], 2), spct(by[a]?.mom, 2)],
      [T('Core, yearly', 'Subyacente, anual'), pct(n.y?.[b]), pct(by[b]?.value)],
      [T('Core, monthly', 'Subyacente, mensual'), spct(n.m?.[b], 2), spct(by[b]?.mom, 2)],
    ]
    return `${table(rows, [T('Estimate', 'Estimación'), T('Last report', 'Último informe')])}
      <div style="${SMALL}">${T(`Cleveland Fed nowcast for ${esc(monthName(period))}, updated ${d.nowcast.asOf ? esc(fmtDate(d.nowcast.asOf)) : 'recently'}. A statistical model, and not a survey of economists.`, `Nowcast de la Fed de Cleveland para ${esc(monthName(period))}, actualizado ${d.nowcast.asOf ? esc(fmtDate(d.nowcast.asOf)) : 'recientemente'}. Un modelo estadístico, no una encuesta a economistas.`)}${miss ? ' ' + T(`Over its last ${miss.n} reports, its final monthly estimate was off by ${miss.avg.toFixed(2)} pt on average, and by as much as ${miss.max.toFixed(2)} pt.`, `En sus últimos ${miss.n} informes, su estimación mensual final falló ${miss.avg.toFixed(2)} pt de media, y hasta ${miss.max.toFixed(2)} pt.`) : ''}</div>`
  }
  const none = (why) => `<p style="${P}">${why}</p>`
  const year = d.sep?.year
  switch (kind) {
    case 'cpi': return nowcast('cpi', 'core') ?? none(T('No estimate is available for this report right now.', 'No hay ninguna estimación disponible ahora para este informe.'))
    case 'pce': return nowcast('pce', 'corepce') ?? none(T('No estimate is available for this report right now.', 'No hay ninguna estimación disponible ahora para este informe.'))
    case 'gdp': {
      const q = (date) => { const t = new Date(date + 'T12:00:00Z'); return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${t.getUTCFullYear()}` }
      const rows = []
      if (by.gdp?.value != null) rows.push([T(`${q(by.gdp.date)}, latest estimate`, `${q(by.gdp.date)}, última estimación`), pct(by.gdp.value)])
      if (d.gdpnow) rows.push([T(`${q(d.gdpnow.date)}, Atlanta Fed GDPNow`, `${q(d.gdpnow.date)}, GDPNow de la Fed de Atlanta`), pct(d.gdpnow.value)])
      if (d.sep?.gdp != null) rows.push([T(`${year}, Fed officials' median`, `${year}, mediana de la Fed`), pct(d.sep.gdp)])
      if (!rows.length) return none(T('No estimate is available right now.', 'No hay ninguna estimación disponible ahora.'))
      return `<div style="display:grid;grid-template-columns:1fr auto;gap:5px 14px">${rows.map(([l, v]) => `<div style="font-size:12px;color:var(--fg-2)">${esc(l)}</div><div style="font-size:12px;font-weight:800;font-family:var(--font-mono);text-align:right">${v}</div>`).join('')}</div>
        <div style="${SMALL}">${T('This report revises a quarter that has already had its first estimate. GDPNow is a running model of the quarter under way, and the Fed\'s figure is growth across the year, so they measure different things.', 'Este informe revisa un trimestre que ya tuvo su primera estimación. GDPNow es un modelo continuo del trimestre en curso, y la cifra de la Fed es el crecimiento de todo el año, así que miden cosas distintas.')}</div>`
    }
    case 'fomc': {
      const f = by.fed
      const rows = []
      if (f?.value != null) rows.push([T('Target range now', 'Rango objetivo ahora'), f.low != null ? `${f.low.toFixed(2)}–${f.value.toFixed(2)}%` : pct(f.value, 2)])
      if (d.sep?.rate != null) rows.push([T(`Officials' median, end of ${year}`, `Mediana de la Fed, fin de ${year}`), pct(d.sep.rate)])
      if (d.sep?.rateNext != null) rows.push([T(`Officials' median, end of ${year + 1}`, `Mediana de la Fed, fin de ${year + 1}`), pct(d.sep.rateNext)])
      if (d.sep?.core != null) rows.push([T(`Core PCE they expect, ${year}`, `PCE subyacente que esperan, ${year}`), pct(d.sep.core)])
      if (!rows.length) return none(T('No estimate is available right now.', 'No hay ninguna estimación disponible ahora.'))
      return `<div style="display:grid;grid-template-columns:1fr auto;gap:5px 14px">${rows.map(([l, v]) => `<div style="font-size:12px;color:var(--fg-2)">${esc(l)}</div><div style="font-size:12px;font-weight:800;font-family:var(--font-mono);text-align:right">${esc(v)}</div>`).join('')}</div>
        <div style="${SMALL}">${T('From the Fed\'s latest published projections, the views of its own officials. They are not a promise, and they change at each projection meeting.', 'De las últimas proyecciones publicadas por la Fed, las opiniones de sus propios miembros. No son una promesa y cambian en cada reunión con proyecciones.')}</div>`
    }
    case 'jobs': {
      const pay = by.payrolls?.pts?.slice(-3).map(p => p[1]) ?? []
      const avg = pay.length === 3 ? pay.reduce((a, b) => a + b, 0) / 3 : null
      const k = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(0) + 'K'
      const rows = []
      if (by.payrolls?.value != null) rows.push([T('Jobs added, last report', 'Empleos, último informe'), k(by.payrolls.value)])
      if (avg != null) rows.push([T('Jobs added, 3-month average', 'Empleos, media de 3 meses'), k(avg)])
      if (by.unrate?.value != null) rows.push([T('Unemployment, last report', 'Desempleo, último informe'), pct(by.unrate.value)])
      if (d.sep?.unemp != null) rows.push([T(`Fed officials' median, ${year}`, `Mediana de la Fed, ${year}`), pct(d.sep.unemp)])
      return `<p style="${P}">${T('No public institution publishes a free estimate for this report, so here is where things stand.', 'Ninguna institución pública publica una estimación gratuita de este informe, así que esta es la situación actual.')}</p>
        ${rows.length ? `<div style="display:grid;grid-template-columns:1fr auto;gap:5px 14px;margin-top:7px">${rows.map(([l, v]) => `<div style="font-size:12px;color:var(--fg-2)">${esc(l)}</div><div style="font-size:12px;font-weight:800;font-family:var(--font-mono);text-align:right">${esc(v)}</div>`).join('')}</div>` : ''}`
    }
    case 'ppi': return `<p style="${P}">${T('No public institution publishes a free estimate for this report.', 'Ninguna institución pública publica una estimación gratuita de este informe.')}${by.ppi?.value != null ? ' ' + T(`Last report: ${pct(by.ppi.value)} yearly, ${spct(by.ppi.mom, 2)} on the month.`, `Último informe: ${pct(by.ppi.value)} anual, ${spct(by.ppi.mom, 2)} en el mes.`) : ''}</p>`
    case 'jolts': return `<p style="${P}">${T('No public institution publishes a free estimate for this report.', 'Ninguna institución pública publica una estimación gratuita de este informe.')}${by.jolts?.value != null ? ' ' + T(`Last report: ${by.jolts.value.toFixed(2)} million openings.`, `Último informe: ${by.jolts.value.toFixed(2)} millones de vacantes.`) : ''}</p>`
    default: return ''
  }
}

function reactionHtml(kind, d, deps) {
  const { T } = deps
  const r = d.reactions?.[kind]
  if (!r?.n) return ''
  const exp = deps.exposure?.()
  let yours = ''
  if (exp && exp.n > 0) {
    const net = exp.long - exp.short
    const move = Math.abs(net) * r.avgAbs / 100
    const side = net >= 0 ? T('net long', 'neto largo') : T('net short', 'neto corto')
    yours = `<p data-ev-yours style="${P};margin-top:8px"><b>${T('Your positions', 'Tus posiciones')}:</b> ${T(`${money(Math.abs(net))} ${side} across ${exp.n} position${exp.n === 1 ? '' : 's'} (${money(exp.long)} long, ${money(exp.short)} short). A ${r.avgAbs.toFixed(1)}% move would be about ${money(move)} either way.`, `${money(Math.abs(net))} ${side} en ${exp.n} posición${exp.n === 1 ? '' : 'es'} (${money(exp.long)} en largo, ${money(exp.short)} en corto). Un movimiento del ${r.avgAbs.toFixed(1)}% serían unos ${money(move)} en cualquier dirección.`)}</p>
      <div style="${SMALL}">${T('A rough scale, assuming everything moves like Bitcoin. Altcoins often move further, and non-crypto markets move differently.', 'Una escala aproximada, suponiendo que todo se mueve como Bitcoin. Las altcoins suelen moverse más, y los mercados no cripto se mueven de otra forma.')}</div>`
  }
  return `<div style="${H}">${T('How Bitcoin moved on these days', 'Cómo se movió Bitcoin esos días')}</div>
    <p data-ev-reaction style="${P}">${T(`On the ${r.n} report day${r.n === 1 ? '' : 's'} of the past year, Bitcoin moved ${r.avgAbs.toFixed(1)}% on average in one direction or the other, against ${r.normal.toFixed(1)}% on a typical day. It closed higher on ${r.up} of ${r.n}.`, `En ${r.n === 1 ? 'el día' : `los ${r.n} días`} de informe del último año, Bitcoin se movió de media un ${r.avgAbs.toFixed(1)}% en una u otra dirección, frente al ${r.normal.toFixed(1)}% de un día típico. Cerró al alza en ${r.up} de ${r.n}.`)}</p>
    <div data-dragscroll style="display:flex;gap:10px;overflow-x:auto;margin-top:7px">${r.recent.map(([day, m]) => `<div style="flex-shrink:0"><div style="font-size:10px;color:var(--muted);white-space:nowrap">${shortDay(day)}</div><div style="font-size:12px;font-weight:700;font-family:var(--font-mono)">${spct(m)}</div></div>`).join('')}</div>
    <div style="${SMALL}">${T('Whole-day moves in UTC, so they include whatever else happened that day. A year is a small sample, and this does not predict the next one.', 'Movimientos del día completo en UTC, así que incluyen todo lo demás que pasó ese día. Un año es una muestra pequeña, y esto no predice el siguiente.')}</div>
    ${yours}`
}

export function eventDetailHtml(kind, d, deps) {
  const { T, esc } = deps
  const c = copy(T)[kind]
  if (!c) return ''
  const side = ([title, body]) => `<div style="min-width:0"><div style="font-size:12px;font-weight:700">${esc(title)}</div><div style="font-size:12px;line-height:1.5;color:var(--fg-2);margin-top:2px">${esc(body)}</div></div>`
  return `<div data-ev-detail style="padding:0 0 11px">
    <p style="${P}">${esc(c.what)}</p>
    <div style="${H}">${T('What is estimated', 'Qué se estima')}</div>
    ${estimateHtml(kind, d, deps)}
    <div style="${H}">${T('What it can mean', 'Qué puede significar')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px 16px">${side(c.up)}${side(c.down)}</div>
    <p style="${P};margin-top:9px"><b>${T('Everyday money', 'Tu día a día')}:</b> ${esc(c.everyday)}</p>
    <p style="${P};margin-top:5px"><b>${T('Trading around it', 'Al operar')}:</b> ${T('Prices can jump within seconds of the release. Spreads widen, stop orders can fill worse than their price, and high leverage is most exposed to being liquidated.', 'El precio puede saltar en segundos tras la publicación. Los spreads se amplían, las órdenes stop pueden ejecutarse peor que su precio, y el apalancamiento alto es el más expuesto a la liquidación.')}</p>
    <div style="${SMALL}">${T('What surprises the market is the gap against expectations, not the number alone. These are common patterns with plenty of exceptions.', 'Lo que sorprende al mercado es la diferencia con lo esperado, no la cifra sola. Son patrones habituales con muchas excepciones.')}</div>
    ${reactionHtml(kind, d, deps)}
    <div style="${SMALL}">${T('General information, not financial advice.', 'Información general, no asesoramiento financiero.')}</div>
  </div>`
}
