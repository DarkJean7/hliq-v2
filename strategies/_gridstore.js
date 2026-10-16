/**
 * Grid Ladder — SQLite persistence (node:sqlite, built into Node 22; no dependency).
 *
 * One file, data/gridladder.db, shared by the five bot processes (WAL mode, each writes only
 * its own rows) and read by server.js for the panel. The contract is memoryStore's in
 * src/gridrunner.js, and the one property that matters:
 *
 *   applyFills writes each fill's trade id, the cycles it completed and the bot's new state in
 *   ONE transaction. A crash leaves either all of it or none — so a fill can never be counted
 *   without its state change, nor the state changed without the fill being marked as seen,
 *   which is how a restart would count a cycle twice.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const DEFAULT_DB = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'gridladder.db')

function openDb(file) {
  // node:sqlite prints an ExperimentalWarning on Node 22; the bot's stderr is what the server
  // shows as its last error, so that one warning is kept off it.
  const emit = process.emitWarning
  process.emitWarning = (w, ...a) => (String(w?.message ?? w).includes('SQLite') ? undefined : emit.call(process, w, ...a))
  try { return new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(file) }
  finally { process.emitWarning = emit }
}

export function sqliteStore(file = DEFAULT_DB) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = openDb(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS gl_state  (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gl_fills  (key TEXT NOT NULL, tid TEXT NOT NULL, time INTEGER, cloid TEXT, side TEXT, px REAL, sz REAL, fee REAL, PRIMARY KEY (key, tid));
    CREATE TABLE IF NOT EXISTS gl_cycles (key TEXT NOT NULL, pair INTEGER, cycle INTEGER, sz REAL, buy_px REAL, sell_px REAL, fees REAL, profit REAL, time INTEGER);
    CREATE TABLE IF NOT EXISTS gl_events (key TEXT NOT NULL, time INTEGER NOT NULL, kind TEXT, msg TEXT);
    CREATE TABLE IF NOT EXISTS gl_control(key TEXT PRIMARY KEY, cmd TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS gl_cycles_key ON gl_cycles(key, time);
    CREATE INDEX IF NOT EXISTS gl_events_key ON gl_events(key, time);
  `)
  const q = {
    load: db.prepare('SELECT json FROM gl_state WHERE key = ?'),
    save: db.prepare('INSERT INTO gl_state(key, json, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated = excluded.updated'),
    fill: db.prepare('INSERT OR IGNORE INTO gl_fills(key, tid, time, cloid, side, px, sz, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    cycle: db.prepare('INSERT INTO gl_cycles(key, pair, cycle, sz, buy_px, sell_px, fees, profit, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    event: db.prepare('INSERT INTO gl_events(key, time, kind, msg) VALUES (?, ?, ?, ?)'),
    trim: db.prepare('DELETE FROM gl_events WHERE key = ? AND time < (SELECT time FROM gl_events WHERE key = ? ORDER BY time DESC LIMIT 1 OFFSET 500)'),
    events: db.prepare('SELECT time, kind, msg FROM gl_events WHERE key = ? ORDER BY time DESC, rowid DESC LIMIT ?'),
    cycles: db.prepare('SELECT pair, cycle, sz, buy_px AS buyPx, sell_px AS sellPx, fees, profit, time FROM gl_cycles WHERE key = ? ORDER BY time DESC LIMIT ?'),
    keys: db.prepare('SELECT key, json, updated FROM gl_state'),
    setCtl: db.prepare('INSERT INTO gl_control(key, cmd, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET cmd = excluded.cmd, at = excluded.at'),
    getCtl: db.prepare('SELECT cmd, at FROM gl_control WHERE key = ?'),
    delCtl: db.prepare('DELETE FROM gl_control WHERE key = ?'),
  }
  let n = 0
  return {
    load: (key) => { const r = q.load.get(key); return r ? JSON.parse(r.json) : null },
    save: (key, st) => { q.save.run(key, JSON.stringify(st), Date.now()) },
    applyFills(key, list, apply, getState) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const f of list) {
          const r0 = q.fill.run(key, String(f.tid), +f.time || 0, f.cloid ?? null, f.side ?? null, +f.px, +f.sz, +f.fee || 0)
          if (!r0.changes) continue                     // seen before: counted once, ever
          const r = apply(f)
          const c = r?.cycleDone
          if (c) q.cycle.run(key, c.pair, c.cycle, c.sz, c.buyPx, c.sellPx, c.fees, c.profit, c.time)
        }
        q.save.run(key, JSON.stringify(getState()), Date.now())
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    event(key, kind, msg) {
      q.event.run(key, Date.now(), kind, String(msg).slice(0, 500))
      if (++n % 50 === 0) q.trim.run(key, key)
    },
    events: (key, limit = 50) => q.events.all(key, limit),
    cycles: (key, limit = 200) => q.cycles.all(key, limit),
    all: () => q.keys.all().map(r => ({ key: r.key, state: JSON.parse(r.json), updated: r.updated })),
    /** A stop request from the server, read by the bot when it is told to exit. */
    setControl: (key, cmd) => q.setCtl.run(key, cmd, Date.now()),
    control: (key) => q.getCtl.get(key) ?? null,
    clearControl: (key) => q.delCtl.run(key),
    close: () => db.close(),
  }
}

/** The key a bot's rows live under: network, the account it trades, and its slot in the ladder. */
export const ladderKey = (network, tradeAddr, id) => `${network}:${String(tradeAddr).toLowerCase()}:${id}`
