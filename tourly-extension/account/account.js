// Standalone tab for the email/code flow (Chrome closes the popup on focus loss, so checking
// email would otherwise kill an in-progress form — this page just stays open in a real tab).
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'email' ? 'email' : 'email_change'; // default: add-email upgrade

function bg(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? null : r)); }
    catch (e) { resolve(null); }
  });
}

if (mode === 'email') {
  $('title').textContent = 'Sign in to Tourly';
  $('subtitle').textContent = 'Sign in to an account you already added an email to, on another device.';
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(id) { $(id).classList.add('hidden'); }

// Read the email straight from its input at the moment of use, rather than caching it in a
// separate variable that only gets set once — the input keeps its value even while its step is
// hidden (display:none doesn't clear form values), so this can't silently drift out of sync.
function currentEmail() { return $('email').value.trim(); }

async function sendCode() {
  const email = currentEmail();
  clearError('emailError');
  if (!email) { showError('emailError', 'Enter an email address.'); return; }
  $('sendCode').disabled = true; $('sendCode').textContent = 'Sending…';
  const res = await bg({ type: mode === 'email_change' ? 'authAddEmail' : 'authSignIn', email });
  $('sendCode').disabled = false; $('sendCode').textContent = 'Send code';
  if (!res || !res.ok) { showError('emailError', (res && res.error) || 'Could not send code.'); return; }
  $('codeEmailLabel').textContent = email;
  $('emailStep').classList.add('hidden');
  $('codeStep').classList.remove('hidden');
  $('code').focus();
}

async function verifyCode() {
  const email = currentEmail();
  const code = $('code').value.trim();
  clearError('codeError');
  if (!email) { showError('codeError', 'Something reset — go back and re-enter your email.'); return; }
  if (!code) { showError('codeError', 'Enter the code from your email.'); return; }
  $('verifyCode').disabled = true; $('verifyCode').textContent = 'Confirming…';
  const res = await bg({ type: 'authVerifyCode', mode, email, token: code });
  $('verifyCode').disabled = false; $('verifyCode').textContent = 'Confirm';
  if (!res || !res.ok) { showError('codeError', (res && res.error) || 'Invalid or expired code.'); return; }
  $('codeStep').classList.add('hidden');
  $('doneTitle').textContent = mode === 'email' ? 'Signed in' : 'Email added';
  $('doneSub').textContent = mode === 'email'
    ? 'Signed in as ' + res.email + '. You can close this tab and reopen the Tourly popup.'
    : 'Your tours are now backed up to ' + res.email + '. You can close this tab.';
  $('doneStep').classList.remove('hidden');
}

$('sendCode').addEventListener('click', sendCode);
$('email').addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
$('verifyCode').addEventListener('click', verifyCode);
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
$('resend').addEventListener('click', sendCode);
