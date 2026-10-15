// Content script on wealthsimpleadmin.mycardplace.com — fills the i2c admin portal login
// form with the credentials stored in the extension's Settings page, and optionally
// clicks Sign In.
//
// Separate from content/i2c.ts because it's a different portal with its own login, and
// none of the Call Center chain steps apply here. The login is a server-rendered JSP
// (loginForm → /cards/Login.do, fields userID + userPassword), so the inputs exist by
// document_idle. We retry a few times anyway in case the form is replaced after first paint.

export {}; // Module-scoped so helpers don't collide with other content scripts at the TS layer.

const I2C_ADMIN_KEY = 'i2c_admin_credentials';

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-i2c-admin]', msg, ...args);
}

interface StoredCreds {
  username: string;
  password: string;
  autoSubmit: boolean;
}

async function loadCreds(): Promise<StoredCreds | null> {
  try {
    const res = await chrome.storage.local.get(I2C_ADMIN_KEY);
    const v = res[I2C_ADMIN_KEY];
    if (!v || !v.username || !v.password) return null;
    return { username: String(v.username), password: String(v.password), autoSubmit: !!v.autoSubmit };
  } catch {
    return null;
  }
}

function isVisible(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findFields(): { username: HTMLInputElement; password: HTMLInputElement } | null {
  const form = document.querySelector<HTMLFormElement>('form[name="loginForm"]');
  const scope: ParentNode = form || document;
  const password = scope.querySelector<HTMLInputElement>('input[name="userPassword"]')
    || scope.querySelector<HTMLInputElement>('input[type="password"]');
  const username = scope.querySelector<HTMLInputElement>('input[name="userID"]');
  if (!password || !username || !isVisible(password) || !isVisible(username)) return null;
  return { username, password };
}

function setValue(el: HTMLInputElement, value: string) {
  // Native setter so any framework bound to the input sees the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findSubmit(form: HTMLFormElement | null): HTMLElement | null {
  const byId = document.getElementById('loginSubmitBtn');
  if (byId) return byId;
  return (form || document).querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
}

let filledOnce = false;
async function tryAutofill(): Promise<boolean> {
  if (filledOnce) return true;
  const creds = await loadCreds();
  if (!creds) return false;
  const fields = findFields();
  if (!fields) return false;
  setValue(fields.username, creds.username);
  setValue(fields.password, creds.password);
  filledOnce = true;
  log('filled login form');
  if (creds.autoSubmit) {
    const btn = findSubmit(fields.password.form);
    // Defer one tick so the page's own required-field validation sees the values.
    if (btn) setTimeout(() => btn.click(), 50);
    else log('no Sign In button found — left filled for a manual click');
  }
  return true;
}

(async () => {
  for (let i = 0; i < 10; i++) {
    if (await tryAutofill()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
})();
