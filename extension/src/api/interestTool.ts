// Interest Validation tool launcher.
//
// The tool is a local Streamlit app (~/Documents/interest-tool) served on
// localhost:8501. Chrome can't execute `Start App.command` itself, so this
// module probes the app first and only falls back to the native messaging host
// (native-host/wocoo_launcher.py, registered by native-host/install.sh) when
// the app isn't already running.

const NATIVE_HOST = 'com.wealthsimple.wocoo_launcher';

export const INTEREST_TOOL_ORIGIN = 'http://localhost:8501';
const HEALTH_URL = `${INTEREST_TOOL_ORIGIN}/_stcore/health`;

/** Streamlit answers /_stcore/health as soon as it's serving. */
export async function isInterestToolUp(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sendNative(message: object): Promise<{ ok?: boolean; error?: string } | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message ?? 'Native host unavailable')); return; }
      resolve(response as { ok?: boolean; error?: string } | undefined);
    });
  });
}

/** Asks the native host to `open` the tool's Start App.command, as if double-clicked. */
export async function launchInterestTool(): Promise<void> {
  let response;
  try {
    response = await sendNative({ action: 'launch_interest_tool' });
  } catch (e) {
    throw new Error(
      `Couldn't reach the launcher (${e instanceof Error ? e.message : String(e)}). ` +
      'Run native-host/install.sh once, then fully quit and reopen Chrome.',
    );
  }
  if (!response?.ok) throw new Error(response?.error || 'The launcher could not start the tool.');
}

/** Polls until Streamlit is serving. First run installs deps, so allow a couple of minutes. */
export async function waitForInterestTool(timeoutMs = 150_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isInterestToolUp(1000)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Ticket context passed to the tool as query params. The Streamlit app ignores
 * unknown params today — reading them (`st.query_params`) is the prefill step.
 */
export interface InterestToolContext {
  identityId?: string;
  ticketId?: string;
}

export function interestToolUrl({ identityId, ticketId }: InterestToolContext): string {
  const url = new URL(INTEREST_TOOL_ORIGIN);
  if (identityId) url.searchParams.set('identity', identityId);
  if (ticketId) url.searchParams.set('wocoo', ticketId);
  return url.toString();
}

/**
 * Opens the tool, starting it first if needed.
 * Returns 'opened' when it was already running, 'started' when it had to be launched.
 */
export async function openInterestTool(context: InterestToolContext): Promise<'opened' | 'started'> {
  const url = interestToolUrl(context);
  if (await isInterestToolUp()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return 'opened';
  }
  await launchInterestTool();
  const up = await waitForInterestTool();
  if (!up) {
    throw new Error(
      'Tool launched but it hasn\'t started serving yet — check the Terminal window ' +
      '(a first run installs dependencies, and it prompts for Satori credentials), then click again.',
    );
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return 'started';
}
