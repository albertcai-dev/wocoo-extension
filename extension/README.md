# WOCOO Triage — Chrome Extension

Side-panel Chrome extension for the Wealthsimple Cash & Card Operations triage workflow.

See `../PRD.md` for the long-term vision, `../design-brief.md` for the design intent.

## Status

**Phase A — scaffold + mock-data Ticket-in-Context side panel.** Loads in Chrome, renders a Mint-styled side panel showing a mock WOCOO-22597 ticket so the visual layout can be reviewed before Jira OAuth is wired up.

## Stack

- Manifest V3
- Vite + React + TypeScript
- `@crxjs/vite-plugin` for the MV3 build pipeline
- Mint DS Web 1.0 (Patchwork) semantic tokens — implemented as CSS custom properties (see `src/styles/mint-tokens.css`). These are approximations; verify against the canonical Figma file before locking visual details.

## Develop

```bash
cd extension
npm install
npm run dev   # starts Vite + writes a dev-mode unpacked extension to dist/
```

Then load the extension in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `extension/dist/` folder
5. Click the WOCOO Triage icon in the Chrome toolbar — the side panel should open

The side panel auto-reloads on file save (Vite HMR via `@crxjs/vite-plugin`).

## Build a release

```bash
npm run build
```

Output goes to `dist/`. Zip that folder and share for sideload installs.

## Project structure

```
extension/
├── manifest.json
├── package.json
├── vite.config.ts
├── tsconfig.json
├── public/icons/             # placeholder icons (replace before release)
└── src/
    ├── sidepanel/            # Side panel UI (Phase A focus)
    │   ├── index.html
    │   ├── main.tsx
    │   └── SidePanel.tsx     # Ticket-in-Context layout
    ├── content/
    │   └── jira.ts           # Content script on wealthsimple.atlassian.net (placeholder)
    ├── background/
    │   └── service-worker.ts # Opens side panel on toolbar-icon click
    ├── components/
    │   ├── StatusBadge.tsx   # StatusBadge + PriorityIndicator + TierBadge
    │   └── TranscriptCard.tsx # 4-state transcript card (Phase A renders success only)
    ├── data/
    │   └── mockTicket.ts     # WOCOO-22597 mock data
    └── styles/
        └── mint-tokens.css   # Mint semantic-color CSS custom properties
```

## What's next (Phase B+)

- Atlassian OAuth via `chrome.identity.launchWebAuthFlow`
- Content script: detect current WOCOO ticket from URL → push to side panel
- Zendesk widget DOM scrape (the "headline feature")
- Quick Actions (transition, comment, reassign) calling Jira REST
- Move workflow modal
- Overpayment Triage in-panel workflow
- Responsive 280–520px layouts (currently fixed to default ~360px)
