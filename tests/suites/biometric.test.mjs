// Face ID / Touch ID unlock.
//
// The feature was built and then reported as missing, which it effectively was: the row
// only rendered once a PIN already existed, so a user with no PIN saw a PIN field and no
// hint that biometrics were an option at all. A capability nobody can find is not shipped.
//
// The other half is honesty about the device. window.PublicKeyCredential exists in every
// modern browser and says nothing about whether there is a sensor behind it, so gating on
// it alone offers "Set Up" to a desktop whose only possible outcome is a dialog that
// cannot succeed.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

console.log(nl + '-- enrolment is a real platform authenticator --')
t('it asks for the device sensor, not a roaming key',
  CLI.includes("authenticatorAttachment: 'platform'"))
t('and requires the user actually verify',
  CLI.includes("userVerification: 'required'"))
t('the challenge is random, not fixed', CLI.includes('crypto.getRandomValues(challenge)'))
t('the credential id is what gets stored', CLI.includes("localStorage.setItem(_BIO_KEY, id)"))

console.log(nl + '-- the device is asked whether it can do this --')
t('availability is probed, not assumed',
  CLI.includes('isUserVerifyingPlatformAuthenticatorAvailable'))
t('the probe has its own function', CLI.includes('async function _probeBiometric()'))
t('unknown is a third state, not false',
  CLI.includes('let _bioAvail = null') && CLI.includes("_bioAvail === null ? 'Checking this device"))
t('why PublicKeyCredential alone is not the test is recorded',
  CLI.includes('says nothing about'))
t('a device that cannot do it is not offered it', CLI.includes('${_bioAvail !== false ?'))
t('and the probe runs once at load, not per render',
  CLI.includes('_probeBiometric().then('))

console.log(nl + '-- the row is findable before a PIN exists --')
t('it no longer hides behind pinEnabled',
  !CLI.includes('${pinEnabled && window.PublicKeyCredential ?'))
t('without a PIN it says what is needed first',
  CLI.includes('Set a PIN first'))
t('and why — a scan can fail', CLI.includes('the way back in if a scan fails'))
t('the button is disabled rather than absent',
  CLI.includes("(!pinEnabled || _bioAvail === null) ? 'disabled"))
t('why hiding it was the bug is written down',
  CLI.includes('why this') && CLI.includes('reported as missing'))

console.log(nl + '-- unlocking, and getting back out --')
t('the lock screen offers biometrics first when enrolled',
  CLI.includes("localStorage.getItem('hliq_biometric_cred')"))
t('with a way back to the PIN pad', CLI.includes('window.__pinShowPad'))
t('and disabling the PIN clears the credential too',
  CLI.includes("localStorage.removeItem('hliq_biometric_cred')"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
