# Eligibility: accept senders from known insurer domains (not just listed addresses)

User (2026-10-12): an eligibility request from Sara Sinclair <Sara.Sinclair@crawco.ca> was missed — she isn't on the
CC Ops Automation "Insurers" tab, so the bridge counted her email as an unknown sender. Crawford (crawco.ca) has many
adjusters; the user chose: treat any sender from a known insurer DOMAIN as an insurer.

## Apps Script — gas/cc-ops-eligibility/Eligibility.gs
1. Derive insurer domains from the Insurers tab's normalised addresses (`eligLoadInsurers_` keys → part after '@',
   lowercased), MINUS a generic/internal exclusion set:
   `wealthsimple.com, gmail.com, googlemail.com, google.com, okta.com, outlook.com, hotmail.com, live.com, msn.com,
   yahoo.com, yahoo.ca, icloud.com, me.com, aol.com, protonmail.com, proton.me` plus any domains listed (comma-separated)
   in optional Script Property `ELIG_EXCLUDED_DOMAINS`, plus any domains in optional `ELIG_EXTRA_INSURER_DOMAINS` added.
   Expose a helper `eligInsurerMatcher_(insurers)` → `{ domains: string[], match(addr): 'listed' | 'domain' | null }`
   (listed = exact address on the tab; domain = domain in the set; null otherwise).
2. `eligList_`:
   - The insurer search query's `{from:… }` group includes every listed address AND `from:<domain>` for each insurer
     domain (Gmail matches a bare domain in `from:`).
   - The per-thread insurer check uses `match(...)` (listed or domain).
   - Each returned request (and rehydrated drafted item) gets `senderMatch: 'listed' | 'domain'`.
   - The unknown-sender count query excludes both the listed addresses and the insurer domains (`-{from:a … from:dom …}`).
   - `originalBody`'s "first insurer message" uses the same matcher.
   - `excludedDomains` returned to the extension = insurer domains ∪ {'wealthsimple.com'} (unchanged meaning: addresses
     on these domains are never treated as the client's).
3. `eligCreateDraftCore_` insurer-sender check uses the matcher (domain senders may be drafted; non-insurers still refused).
4. Gmail query length: with domains added the group gets longer; if the built query exceeds ~1,500 characters, split the
   from-group into several searches (each ≤ ~1,500 chars) and union the threads by id. Keep paging/caps per search.
5. README + header comment: describe domain matching and the two optional Script Properties.
6. node --check on a temp .js copy; extend the scratchpad stub harness if available (domain sender listed; generic
   domain excluded; non-insurer refused at draft).

## Extension
- `RawEligibilityEmail.senderMatch?: 'listed' | 'domain'` (bridge maps defensively; default 'listed').
- Pure helper (eligibilityRunState.ts or eligibilityParse.ts) `domainOnlySenders(rows): string[]` — distinct
  lowercased sender addresses of rows whose `req`/raw senderMatch is 'domain', sorted. Carry senderMatch onto
  EligibilityRequest (optional) so the panel can read it. Test it.
- Panel: when `domainOnlySenders(run.rows).length > 0`, show an infoCard-styled banner:
  "N request(s) came from insurer-domain senders not on the Insurers tab: a@x, b@y. Add them to the tab to keep the
  old CC Ops process in sync." In each such row's expanded section, a soft note "Sender matched by insurer domain (not on
  the Insurers tab)". No flag, no blocking — these rows resolve and draft like any other.

## Gate
From extension/: `npx tsc -b && npm test && npm run build`; node --check on the .gs. Commit explicit paths, trailer
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. If 1Password signing errors, don't bypass — leave staged, report BLOCKED.
