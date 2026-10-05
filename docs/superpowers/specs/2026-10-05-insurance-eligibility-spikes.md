# Insurance Eligibility Triage — spike findings

## S1 — Preset SQL from the extension (2026-10-05)
- From the side panel: csrf_token 200 (cookies sent); sqllab/execute 400 "The referrer header is missing."
- fetch `referrer`/`referrerPolicy` from the extension: still 400 (browser drops it).
- From a Preset page (DevTools console): execute 200, synchronous, `data: [{ ok: 1 }]`.
- Decision: run SQL from a hidden Preset tab via chrome.scripting.executeScript (world MAIN). PRESET_DIRECT_ENABLED = true.
