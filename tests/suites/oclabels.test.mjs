// Outcome labels in orders, positions and history: a new-template market's leg used to reach
// them as its template name ("template:sportsTournamentParticipant · Yes"), and on the phone that
// label, repeated under the size, ran over the price and size columns.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const M   = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const CSS = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

t('a leg is labelled "<market title> · <leg>", not by its name', M.includes("if (qTitle && d.class !== 'priceBucket') displayName = qTitle + ' · ' + _ocLegName(o)"))
t('every leg, the fallback "Other" included, knows its market title', M.includes('const legs  = [...(q.namedOutcomes ?? []), q.fallbackOutcome].filter(x => x != null)') && M.includes('legTitle.set(Number(oid), _ocQuestionTitle(q))'))
t('the cards and the labels name legs with one helper', M.includes('const rowName = (o) => _ocLegName(o)') && M.includes('function _ocLegName(o) {'))
t('a tournament is titled by season and competition', M.includes("return [qd.season, qd.competition].filter(Boolean).join(' ').trim() || 'Tournament winner'"))
t('a standalone template market is labelled by its question', M.includes('const fq = _buildFullQuestion(d, o.name)') && M.includes("if (txt && !/^template:/.test(txt)) displayName = txt"))
for (const tpl of ['sportsContestWinner', 'sportsTotal', 'sportsSpread', 'companyIpoConfirmed', 'companyIpoFirstDayMarketCap'])
  t(`the question builder knows template:${tpl}`, M.includes(`tn === 'template:${tpl}'`))
t('side placeholders ("{shortNameA}") are filled from the description', M.includes('function _ocSideName(raw, fallback, d) {') && M.includes("_ocSideName(o.sideSpecs[i].name, 'Yes', d)"))
t('labels, titles and settle dates cached in an old form are rebuilt', M.includes("localStorage.getItem('hliq_oc_label_fmt') !== '4'") && M.includes("localStorage.removeItem('hliq_oc_info_map')"))
// A leg's position card read 'Question: template:sportsTournamentWinner' and had no Settles row.
t('a template question is stored under its title, not its name', M.includes('const title = /^template:/.test(qName) ? _ocQuestionTitle(q) : qName'))
t('a leg settles when its question does', M.includes('if (qEnd) for (const oid of legs) legEnd.set(Number(oid), qEnd)') && M.includes('|| legEnd.get(Number(o.outcome)) || null'))
t('a game settles at its own resolutionDeadline', M.includes('const end = d.expiry || d.scheduledDecision || d.resolutionDeadline || d.decisionDeadline ||'))
t('a card whose title is still a template falls back to its label', M.includes("if (/^template:|^Recurring Named/.test(line1 || '')) {"))

t('the phone order row puts only the side under the size', (M.match(/\$\{esc\(_ocOrdUnit\((o|g)\.coin\)\)\}/g) || []).length === 2)
t('and nowhere repeats the whole label there', !/mob-v-row-pct" style="color:var\(--muted\)">\$\{esc\(_ocCoinLabel/.test(M))
t('a phone row name is held to two lines in its own column', CSS.includes('.mob-v-row-info > .mob-v-row-name { display: -webkit-box; -webkit-line-clamp: 2;') && CSS.includes('overflow-wrap: anywhere'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
