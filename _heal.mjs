import { chromium, devices } from 'playwright'
const b = await chromium.launch()
const ctx = await b.newContext({ ...devices['iPhone 13'] })
const p = await ctx.newPage()
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('dialog',d=>d.accept())
await p.goto('https://insolvent.trade',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500)
await p.evaluate(()=>{localStorage.clear();localStorage.setItem('hliq_force_mobile','1');localStorage.setItem('walletAddr','__paper__')})
await p.reload({waitUntil:'domcontentloaded'}); await p.waitForTimeout(10000)

// Build history: one completed round trip.
await p.evaluate(async()=>{
  window.__selectCoin('BTC'); window._mobVSetOrderType?.('market')
  window._mobOpenOrderSheet('buy'); await new Promise(r=>setTimeout(r,1500))
  const a=document.getElementById('mobTradeAmtInput'); a.value='100'; a.dispatchEvent(new Event('input',{bubbles:true}))
  await new Promise(r=>setTimeout(r,600)); await window._mobTradeSubmitNew() })
await p.waitForTimeout(5000)
await p.evaluate(()=>window.__closeAllPositions(document.createElement('button')))
await p.waitForTimeout(9000)
const name = await p.evaluate(()=>localStorage.getItem('hliq_paper_name'))
console.log('▶ account name:', name)
let board = await p.evaluate(async()=>(await (await fetch('/api/leaderboard/paper')).json()).rows.map(r=>r.name))
console.log('   board after trade:', JSON.stringify(board))
