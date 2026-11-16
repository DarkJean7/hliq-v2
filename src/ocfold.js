// Folding in the Outcomes list: what is shown, and the banners you open things with.
//
// Asked for: "make the folded outcomes sections more showy. then lets also unextend all other
// types of types. for example if i press sports it should show me the folded types of outcomes".
//
// Two levels fold. A SECTION (Crypto, Sports, ...) is one banner until opened. Inside it, a
// GROUP — a sport, or the coin a crypto market is about — is one banner too, so choosing Sports
// shows Basketball, American Football, Soccer folded rather than every game at once.
//
// Folding is for browsing. A search or a market chip is a request for results, and shows them
// whatever is folded.
//
// Pure: no DOM, no state. main.js asks and applies.

// Each section's colours: a light and a deep stop for the banner gradient.
export const CAT_THEME = {
  crypto:      { a: '#f7a43a', b: '#3a2205' },
  commodities: { a: '#d9a441', b: '#2c1f07' },
  sports:      { a: '#8b5cf6', b: '#1c1238' },
  politics:    { a: '#4f7cf0', b: '#0f1a3d' },
  economy:     { a: '#22b8a0', b: '#062a26' },
  tech:        { a: '#7c6cf2', b: '#16123a' },
  business:    { a: '#3fbf6a', b: '#0b2a16' },
  culture:     { a: '#e85b9a', b: '#3a0c22' },
  weather:     { a: '#41b6f0', b: '#0a2738' },
  other:       { a: '#9a8cff', b: '#1a1734' },
}

// The groups a section folds into, by what each card is about. Null: the section is not grouped.
// A section whose markets are all one group gets no group banner — it would only repeat itself.
export function groupKeyOf(cat, card) {
  if (cat === 'sports') return card.sport || 'other'
  if (cat === 'crypto' || cat === 'commodities' || cat === 'economy' || cat === 'tech') return card.und || null
  return null
}

const esc0 = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** A section's banner. `preview` is a short list of what is inside ("BTC · ETH · SOL"). */
export function catHeadHtml({ cat, emoji, label, count, preview = [] }, esc = esc0) {
  const th = CAT_THEME[cat] ?? CAT_THEME.other
  const pv = [...new Set(preview.filter(Boolean))]
  const more = pv.length > 4 ? ` +${pv.length - 4}` : ''
  return `<span class="oc-cat-bg" style="--sp-a:${th.a};--sp-b:${th.b}"></span>` +
    `<span class="oc-cat-glyph">${emoji}</span>` +
    `<span class="oc-cat-txt"><span class="oc-cat-name">${esc(label)}</span>` +
    (pv.length ? `<span class="oc-cat-pv">${esc(pv.slice(0, 4).join(' · ') + more)}</span>` : '') + `</span>` +
    `<span class="oc-cat-n">${count} market${count === 1 ? '' : 's'}</span><span class="oc-sec-chev" aria-hidden="true"></span>`
}

/** A group's banner inside a section that is not Sports (Sports has its own, src/ocsport.js). */
export function groupHeadHtml({ cat, key, label, count, icon = '' }, esc = esc0) {
  const th = CAT_THEME[cat] ?? CAT_THEME.other
  return `<div class="oc-sub-head oc-grp-head" data-cat="${esc(cat)}" data-sub="${esc(key)}" style="--sp-a:${th.a};--sp-b:${th.b}">` +
    `<span class="oc-grp-ic">${icon}</span><span class="oc-grp-name">${esc(label)}</span>` +
    `<span class="oc-sport-n">${count} market${count === 1 ? '' : 's'}</span><span class="oc-sec-chev" aria-hidden="true"></span></div>`
}

/**
 * Whether an item is shown by the folding rules (filters are applied separately).
 *   kind      'card' | 'group' (a group banner)
 *   cat, sub  the item's section and group (sub null: not in a group)
 *   view      { cat: active category, browsing: no search and no market chip }
 *   open      { secs: Set, subs: Set of "cat:sub" }
 */
export function foldShows(kind, cat, sub, view, open) {
  if (!view.browsing) return kind === 'card'                // results: every card, no banners
  if (view.cat !== 'all' && view.cat !== cat) return kind === 'card'   // another category: its filter decides
  const secOpen = view.cat === cat || open.secs.has(cat)    // a chosen category is open by being chosen
  if (!secOpen) return false
  if (kind === 'group') return true
  return !sub || open.subs.has(cat + ':' + sub)
}
