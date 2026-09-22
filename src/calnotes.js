/**
 * INSOLVENT TERMINAL — calendar notes
 *
 * A journal on the PnL calendar: notes written against a day, each with a header (a title
 * and the date). A month's notes sit under the calendar as collapsed cards; pressing one opens
 * it. Pressing a day shows that day's notes in the day panel, with a quiet "+ Add note" — an
 * option, not a prompt.
 *
 * ── where they live ──
 *
 * On this device, under one key, and NOT per account. A note is about the trader's day, not
 * about a wallet: the same journal shows on the single-account calendar, the All Accounts one,
 * and the Accounts tab, which is what you want when one day's trading spans several wallets.
 * It also means no storage key is ever built out of `state.addr`, which in the combined view
 * is the sentinel '__all_accounts__' (CLAUDE.md — a key built from it is written and never
 * read back).
 *
 * The storage rules are pure and take the store as an argument, so they are tested in node:
 * tests/suites/calnotes.test.mjs. The UI half below touches the DOM only when called.
 */
import { esc } from './format.js'

export const LS_KEY = 'hliq_cal_notes_v1'
export const MAX_TITLE = 80
export const MAX_BODY  = 4000

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

/** A calendar day key, 'YYYY-MM-DD', exactly as the calendar builds them. */
export const isDayKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)

/** "September 22, 2026" — the date half of a note's header. */
export function dayLabel(key) {
  if (!isDayKey(key)) return ''
  const [y, m, d] = key.split('-').map(Number)
  return `${MONTHS[m - 1] ?? ''} ${d}, ${y}`
}

/** A stored note, or null. Anything else in storage is ignored rather than trusted. */
export function cleanNote(n) {
  if (!n || !isDayKey(n.day)) return null
  const title = String(n.title ?? '').trim().slice(0, MAX_TITLE)
  const body  = String(n.body ?? '').slice(0, MAX_BODY)
  // A note with neither a title nor a body is nothing; saving one would leave an empty card.
  if (!title && !body.trim()) return null
  const id = typeof n.id === 'string' && /^[a-z0-9]{6,24}$/i.test(n.id) ? n.id : null
  if (!id) return null
  return {
    id, day: n.day, title, body,
    created: Number.isFinite(n.created) ? n.created : Date.now(),
    updated: Number.isFinite(n.updated) ? n.updated : Date.now(),
  }
}

export function loadNotes(store) {
  try {
    const raw = JSON.parse(store?.getItem(LS_KEY) || '[]')
    return (Array.isArray(raw) ? raw : []).map(cleanNote).filter(Boolean)
  } catch { return [] }
}

export function saveNotes(store, list) {
  const clean = (list ?? []).map(cleanNote).filter(Boolean)
  store?.setItem(LS_KEY, JSON.stringify(clean))
  return clean
}

export const newId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 16)

/** Add a note, or replace the one with the same id. */
export function upsertNote(list, note) {
  const n = cleanNote({ ...note, updated: Date.now() })
  if (!n) return list ?? []
  return [...(list ?? []).filter(x => x.id !== n.id), n]
}

export const removeNote = (list, id) => (list ?? []).filter(x => x.id !== id)

/** One day's notes, oldest first — the order they were written in. */
export const notesForDay = (list, key) => (list ?? []).filter(n => n.day === key).sort((a, b) => a.created - b.created)

/** A month's notes (`month` 0-based, as the calendar uses it), by day then by writing order. */
export function notesForMonth(list, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`
  return (list ?? []).filter(n => n.day.startsWith(prefix))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.created - b.created))
}

/** Which days of a month carry a note — for the marker on the cell. */
export const noteDays = (list, year, month) => new Set(notesForMonth(list, year, month).map(n => n.day))

// ─── UI ───────────────────────────────────────────────────────────────────────

const store = () => (typeof localStorage !== 'undefined' ? localStorage : null)
const _open = new Set()   // expanded note cards, by id — survives the calendar re-rendering

// The note's text, kept as written: line breaks shown, nothing interpreted.
const bodyHtml = (s) => esc(s).replace(/\n/g, '<br>')

function cardHtml(n, rootId) {
  const open = _open.has(n.id)
  const title = n.title || 'Note'
  return `<div class="cal-note-card${open ? ' open' : ''}" data-note="${esc(n.id)}">
    <div class="cal-note-head" onclick="window.__calNoteToggle('${esc(n.id)}','${esc(rootId)}')">
      <div class="cal-note-titles">
        <div class="cal-note-title">${esc(title)}</div>
        <div class="cal-note-date">${esc(dayLabel(n.day))}</div>
      </div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" class="cal-note-chev"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    ${open ? `<div class="cal-note-body">
      ${n.body.trim() ? `<div class="cal-note-text">${bodyHtml(n.body)}</div>` : '<div class="cal-note-text" style="color:var(--muted)">No text.</div>'}
      <div class="cal-note-actions">
        <button onclick="window.__calNoteEdit('${esc(n.id)}','${esc(rootId)}')">Edit</button>
        <button class="del" onclick="window.__calNoteDelete('${esc(n.id)}','${esc(rootId)}')">Delete</button>
      </div>
    </div>` : ''}
  </div>`
}

/** The month's notes, as collapsed cards, for under the calendar. Empty string when none. */
export function monthNotesHtml(year, month, rootId) {
  const list = notesForMonth(loadNotes(store()), year, month)
  if (!list.length) return ''
  return `<div class="cal-notes-title">Notes · ${MONTHS[month]} ${year}</div>${list.map(n => cardHtml(n, rootId)).join('')}`
}

/** The day panel's notes section: that day's cards, and the option to write one. */
export function dayNotesHtml(key, rootId) {
  const list = notesForDay(loadNotes(store()), key)
  return `<div class="cal-detail-section cal-day-notes" data-cal-daynotes="${esc(key)}">
    ${list.length ? `<div class="cal-detail-section-title">Notes</div>${list.map(n => cardHtml(n, rootId)).join('')}` : ''}
    <button class="cal-note-add" onclick="window.__calNoteNew('${esc(key)}','${esc(rootId)}')">+ Add note</button>
  </div>`
}

/**
 * Repaint every piece of the notes on screen for one calendar: the month's cards, the open
 * day's section and the cell markers — without rebuilding the calendar, so an open day panel
 * and the scroll position stay where they were.
 */
export function refreshNotes(rootId) {
  if (typeof document === 'undefined') return
  const root = document.getElementById(rootId)
  const cache = root?._calData
  const list = loadNotes(store())
  const box = document.querySelector(`[data-cal-notes="${rootId}"]`)
  if (box && cache) box.innerHTML = monthNotesHtml(cache.year, cache.month, rootId)
  const detail = cache ? document.getElementById(cache.detailId) : null
  const sec = detail?.querySelector('[data-cal-daynotes]')
  if (sec) sec.outerHTML = dayNotesHtml(sec.getAttribute('data-cal-daynotes'), rootId)
  if (root && cache) {
    const days = noteDays(list, cache.year, cache.month)
    root.querySelectorAll('.cal-cell[data-key]').forEach(c => c.classList.toggle('cal-has-note', days.has(c.dataset.key)))
  }
}

// ── the editor ──

let _edit = null   // { id, day, rootId }

function sheet() {
  let ov = document.getElementById('calNoteSheet')
  if (ov) return ov
  ov = document.createElement('div')
  ov.id = 'calNoteSheet'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100050;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6)'
  ov.addEventListener('click', e => { if (e.target === ov) closeEditor() })
  document.body.appendChild(ov)
  return ov
}

export function closeEditor() {
  const ov = document.getElementById('calNoteSheet')
  if (ov) ov.style.display = 'none'
  _edit = null
}

const inputCss = 'width:100%;box-sizing:border-box;background:var(--panel-2);border:1px solid var(--border2);border-radius:10px;padding:10px 11px;color:var(--fg);font-size:14px;outline:none;font-family:inherit'

export function openEditor(day, rootId, id = null) {
  const existing = id ? loadNotes(store()).find(n => n.id === id) : null
  const d = existing?.day ?? day
  if (!isDayKey(d)) return
  _edit = { id: existing?.id ?? null, day: d, rootId }
  const ov = sheet()
  // Opaque, as the off-exchange sheet is: --panel is translucent over a photo backdrop.
  ov.innerHTML = `<div role="dialog" aria-label="Calendar note" style="width:min(520px,100%);max-height:90vh;overflow-y:auto;background:linear-gradient(var(--panel),var(--panel)),var(--bg);border:1px solid var(--border);border-radius:18px 18px 0 0;padding:20px 18px calc(20px + env(safe-area-inset-bottom))">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
      <div>
        <div style="font-size:17px;font-weight:800">${existing ? 'Edit note' : 'New note'}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(dayLabel(d))}</div>
      </div>
      <button onclick="window.__calNoteClose()" aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">&times;</button>
    </div>
    <input id="calNoteTitle" maxlength="${MAX_TITLE}" style="${inputCss};font-weight:700;margin-bottom:10px" placeholder="Title — e.g. Stuck to the plan" value="${esc(existing?.title ?? '')}">
    <textarea id="calNoteBody" maxlength="${MAX_BODY}" rows="8" style="${inputCss};resize:vertical;line-height:1.5" placeholder="What happened, what you'd do differently…">${esc(existing?.body ?? '')}</textarea>
    <div id="calNoteStatus" style="font-size:12px;min-height:16px;margin:6px 0;color:var(--red)"></div>
    <button onclick="window.__calNoteSave()" style="width:100%;padding:12px;border-radius:11px;border:none;background:var(--accent);color:#000;font-weight:800;font-size:14px;cursor:pointer">Save note</button>
  </div>`
  ov.style.display = 'flex'
  // Only if nothing in the sheet has the cursor yet: a late focus() would otherwise pull it
  // out of a field someone has already started typing in.
  setTimeout(() => { if (!ov.contains(document.activeElement)) document.getElementById(existing ? 'calNoteBody' : 'calNoteTitle')?.focus() }, 50)
}

function saveEditor() {
  if (!_edit) return
  const title = document.getElementById('calNoteTitle')?.value ?? ''
  const body  = document.getElementById('calNoteBody')?.value ?? ''
  if (!title.trim() && !body.trim()) {
    const st = document.getElementById('calNoteStatus')
    if (st) st.textContent = 'Write a title or some text first.'
    return
  }
  const s = store()
  const list = loadNotes(s)
  const prev = _edit.id ? list.find(n => n.id === _edit.id) : null
  const note = { id: prev?.id ?? newId(), day: _edit.day, title, body, created: prev?.created ?? Date.now() }
  try { saveNotes(s, upsertNote(list, note)) } catch {
    const st = document.getElementById('calNoteStatus')
    if (st) st.textContent = 'Could not save on this device (storage is full or blocked).'
    return
  }
  _open.add(note.id)   // what you just wrote is shown open
  const rootId = _edit.rootId
  closeEditor()
  refreshNotes(rootId)
}

if (typeof window !== 'undefined') {
  window.__calNoteToggle = (id, rootId) => { _open.has(id) ? _open.delete(id) : _open.add(id); refreshNotes(rootId) }
  window.__calNoteNew    = (day, rootId) => openEditor(day, rootId)
  window.__calNoteEdit   = (id, rootId) => openEditor(null, rootId, id)
  window.__calNoteClose  = () => closeEditor()
  window.__calNoteSave   = () => saveEditor()
  // Two presses, in place: the first arms the button for a few seconds. A native confirm()
  // would freeze the page for a question this small.
  let _armed = { id: null, at: 0 }
  window.__calNoteDelete = (id, rootId) => {
    const s = store()
    if (!loadNotes(s).some(x => x.id === id)) return
    if (_armed.id !== id || Date.now() - _armed.at > 4000) {
      _armed = { id, at: Date.now() }
      document.querySelectorAll(`[data-note="${id}"] .cal-note-actions .del`).forEach(b => { b.textContent = 'Press again to delete' })
      setTimeout(() => {
        if (_armed.id !== id) return
        document.querySelectorAll(`[data-note="${id}"] .cal-note-actions .del`).forEach(b => { b.textContent = 'Delete' })
      }, 4000)
      return
    }
    _armed = { id: null, at: 0 }
    try { saveNotes(s, removeNote(loadNotes(s), id)) } catch {}
    _open.delete(id)
    refreshNotes(rootId)
  }
}
