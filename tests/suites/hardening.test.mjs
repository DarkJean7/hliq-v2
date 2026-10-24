// Server hardening that must not regress: static files only from dist/, directories never read as
// files, every server on loopback behind nginx, rate limits keyed on nginx's real client address.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const PROD = fs.readFileSync('serve-prod.js', 'utf8').replace(/\r\n/g, '\n')
const SRV  = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const NTF  = fs.readFileSync('notify-server.js', 'utf8').replace(/\r\n/g, '\n')

t('a static path outside dist/ is refused', PROD.includes("if (candidate !== DIST && !candidate.startsWith(DIST + sep)) { res.writeHead(404).end(); return }"))
t('only regular files are served (a directory threw and killed the process)', PROD.includes('isFile = statSync(candidate).isFile()') && !PROD.includes("existsSync(candidate) && !candidate.endsWith('/')"))
t('the web server listens on loopback', PROD.includes("const LISTEN_HOST = process.env.HLIQ_LISTEN_HOST || '127.0.0.1'") && PROD.includes('.listen(PORT, LISTEN_HOST,'))
t('and proxies to loopback by address, not "localhost" (which resolves to ::1 first there)', PROD.includes("hostname: '127.0.0.1', port,"))
t('the strategy server listens on loopback', SRV.includes("server.listen(PORT, process.env.HLIQ_LISTEN_HOST || '127.0.0.1',"))
t('the notify server listens on loopback', NTF.includes("app.listen(PORT, process.env.HLIQ_LISTEN_HOST || '127.0.0.1',"))
t('rate limits use nginx\'s X-Real-IP, never the client-written X-Forwarded-For',
  SRV.includes("return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '?').trim()") && !SRV.includes("req.headers['x-forwarded-for']"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
