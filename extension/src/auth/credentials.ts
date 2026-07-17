// i2c login credentials, stored in chrome.storage.local so the content script on
// wealthsimplecs.mycardplace.com can read and autofill them on the login page.
//
// Trust model: chrome.storage.local is scoped to this extension only — other extensions
// and websites can't read it. The data sits on disk in the user's Chrome profile dir
// (encrypted at rest on macOS/Windows via Chrome's profile encryption). Acceptable for
// internal sideload; revisit if this ever ships outside the team.

export interface I2cCredentials {
  username: string;
  password: string;
  autoSubmit: boolean;
}

const I2C_KEY = 'i2c_credentials';

export async function getI2cCredentials(): Promise<I2cCredentials | null> {
  const res = await chrome.storage.local.get(I2C_KEY);
  const v = res[I2C_KEY];
  if (!v || typeof v !== 'object') return null;
  if (!v.username || !v.password) return null;
  return { username: String(v.username), password: String(v.password), autoSubmit: !!v.autoSubmit };
}

export async function setI2cCredentials(creds: I2cCredentials): Promise<void> {
  await chrome.storage.local.set({ [I2C_KEY]: creds });
}

export async function clearI2cCredentials(): Promise<void> {
  await chrome.storage.local.remove(I2C_KEY);
}
