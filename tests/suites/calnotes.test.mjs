// Calendar notes: a journal written against a day, each with a header (title + date), shown
// under the calendar as collapsed cards and in a pressed day's panel. See src/calnotes.js.
import fs from 'fs'
import {
  LS_KEY, isDayKey, dayLabel, cleanNote, loadNotes, saveNotes, upsertNote, removeNote,
  notesForDay, notesForMonth, noteDays, newId, MAX_TITLE,
} from '../../src/calnotes.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), _m: m } }

console.log(nl + '-- the header --')
{
  t('a day key is the calendar\'s own', isDayKey('2026-09-22') && !isDayKey('2026-9-22') && !isDayKey('__all_accounts__'))
  t('the date reads as words', dayLabel('2026-09-22') === 'September 22, 2026')
  t('and never as a guess', dayLabel('nope') === '')
}

console.log(nl + '-- what is kept --')
{
  const id = newId()
  t('ids are short and plain', /^[a-z0-9]{6,24}$/i.test(id))
  t('a title alone is a note', !!cleanNote({ id, day: '2026-09-22', title: 'Plan', body: '' }))
  t('text alone is a note', !!cleanNote({ id, day: '2026-09-22', title: '', body: 'held too long' }))
  t('neither is nothing — no empty cards', cleanNote({ id, day: '2026-09-22', title: '  ', body: ' \n ' }) === null)
  t('a note belongs to a real day', cleanNote({ id, day: '__all_accounts__', title: 'x' }) === null)
  t('titles are capped', cleanNote({ id, day: '2026-09-22', title: 'x'.repeat(500) }).title.length === MAX_TITLE)
  t('storage junk is ignored, not trusted', (() => { const s = mem(); s.setItem(LS_KEY, '{oops'); return loadNotes(s).length === 0 })())
}

console.log(nl + '-- writing, editing, deleting --')
{
  const s = mem()
  let list = loadNotes(s)
  list = upsertNote(list, { id: 'aaaaaa1', day: '2026-09-21', title: 'Grid bot breached its cap', body: 'ADA short went to $147', created: 1 })
  list = upsertNote(list, { id: 'bbbbbb2', day: '2026-09-22', title: 'Calm day', body: '', created: 2 })
  list = upsertNote(list, { id: 'cccccc3', day: '2026-09-21', title: 'Second thought', body: 'x', created: 3 })
  saveNotes(s, list)
  t('stored under one device-wide key', JSON.parse(s.getItem(LS_KEY)).length === 3 && s._m.size === 1)
  t('read back as written', loadNotes(s).find(n => n.id === 'aaaaaa1').body === 'ADA short went to $147')
  list = upsertNote(loadNotes(s), { id: 'aaaaaa1', day: '2026-09-21', title: 'Grid bot breached its cap', body: 'fixed in ee7b0c93', created: 1 })
  t('editing replaces, not duplicates', list.length === 3 && list.find(n => n.id === 'aaaaaa1').body === 'fixed in ee7b0c93')
  t('a day\'s notes, in writing order', notesForDay(list, '2026-09-21').map(n => n.id).join() === 'aaaaaa1,cccccc3')
  t('a month\'s notes, by day', notesForMonth(list, 2026, 8).map(n => n.id).join() === 'aaaaaa1,cccccc3,bbbbbb2')
  t('another month has none', notesForMonth(list, 2026, 9).length === 0)
  t('the days to mark', [...noteDays(list, 2026, 8)].sort().join() === '2026-09-21,2026-09-22')
  t('deleting takes only that one', removeNote(list, 'cccccc3').map(n => n.id).sort().join() === 'aaaaaa1,bbbbbb2')
}

console.log(nl + '-- wired into the calendar --')
{
  const r = fs.readFileSync('src/render.js', 'utf8')
  const css = fs.readFileSync('src/style.css', 'utf8')
  t('every day opens, quiet ones too', /cells \+= `<div class="\$\{cls\}" data-key="\$\{key\}" onclick="window\.__calDayClick/.test(r))
  t('a quiet day gets no activity highlight', /hasActivity \? ' cal-clickable' : ' cal-quiet'/.test(r))
  t('a day with a note is marked', /cal-has-note/.test(r) && /\.cal-cell\.cal-has-note::after/.test(css))
  t('the day panel ends with its notes and the option to write one', /\$\{dayNotesHtml\(key, rootId\)\}`/.test(r))
  t('the month\'s notes go under the calendar', /box\.innerHTML = monthNotesHtml\(year, month, rootId\)/.test(r))
  t('the calendar knows its month, for the notes', /root\._calData = \{[^}]*year, month \}/.test(r))
  // Device-wide, never built from state.addr (the combined view's sentinel).
  const src = fs.readFileSync('src/calnotes.js', 'utf8')
  t('storage never involves an account: one fixed key, one write', /store\?\.setItem\(LS_KEY, /.test(src) && (src.match(/setItem\(/g) ?? []).length === 1 && !/from '\.\/main\.js'/.test(src))
  t('the option is a quiet link, not a button that shouts', /\.cal-note-add \{\s*background: none; border: none/.test(css))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
