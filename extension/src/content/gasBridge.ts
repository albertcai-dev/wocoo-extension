// Content script that runs on script.google.com — the Apps Script bridge target.
//
// When the extension opens a `window.open(BRIDGE_URL + '?action=...')` tab, the popup
// tab's top-level document is served by script.google.com. Inside it, Apps Script
// renders our HtmlService response in a sandboxed googleusercontent iframe. Our reply
// script inside that sandbox posts a message to `window.parent` (the script.google.com
// wrapper) — this content script is same-origin with that wrapper and hears the message.
// We forward it to the extension side panel via chrome.runtime.sendMessage, then close
// the tab.
//
// This bypasses the fundamental cross-origin barrier: the sandbox iframe can't reach the
// extension's chrome-extension:// origin directly, but the wrapper (same-origin with the
// content script) can.

export {};

console.log('[wocoo-gas-bridge] content script loaded on', location.href);

// A GAS reply looks like: { action: 'pendingWiresRead', rows: [...] } or { action: '...',
// error: 'reason' }. We forward anything that looks like a bridge payload; the side panel
// filters by expected action.
function looksLikeBridgePayload(data: unknown): data is { action?: string; error?: string } {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.action === 'string' || typeof d.error === 'string';
}

window.addEventListener('message', (e: MessageEvent) => {
  if (!looksLikeBridgePayload(e.data)) return;
  console.log('[wocoo-gas-bridge] forwarding postMessage:', e.data);
  try {
    chrome.runtime.sendMessage({ source: 'wocoo-gas-bridge', payload: e.data });
  } catch (err) {
    console.warn('[wocoo-gas-bridge] chrome.runtime.sendMessage failed:', err);
  }
  // Give the extension a moment to receive the message, then close the tab. The wrapper
  // is top-level here so window.close() succeeds (script-opened window).
  setTimeout(() => {
    try { window.close(); } catch { /* fine */ }
  }, 300);
});
