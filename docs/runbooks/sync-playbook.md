# Runbook: sync playbook

Mirrors the Notion playbook into the `Playbook` tab of the WOCOO Ticket Log sheet so the
AI triage card can read it through the bridge. Run by hand in a Claude session; there is
no automated sync.

**Source:** Albert's WOCOO Ticket Playbook, Notion page `39241167-bd96-81d5-92b1-da6303f0b22c`.
Only this page tree. The shared team WOCOO page is never a source.

**Destination:** tab `Playbook` (sheet id `772391345`) on `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`.

## Steps

1. Fetch the page tree under *Work types* with the Notion MCP tools.
2. For each work-type page, emit one row per populated block of the 5-block template:
   When applies / Steps / Tools + queries / Gotchas / Example tickets.
3. Skip blocks whose body is still `_TBD_` — a placeholder row is worse than no row,
   because it fills prompt space with nothing.
4. Build each row as:
   - `page_id` — the Notion page id
   - `page_title` — the work-type name, e.g. `Overpayment`
   - `parent_path` — e.g. `Work types`
   - `chunk_key` — `<page_id>#<block-slug>`, e.g. `<id>#steps`. Stable across runs.
   - `chunk_text` — the block's text, flattened to plain prose
   - `updated_at` — the Notion page's last-edited timestamp
5. Upsert into the tab **by `chunk_key`**: overwrite a matching row, append a new one.
   Never clear the tab and rewrite it — that loses rows for pages the run did not reach.
6. Delete rows whose `chunk_key` no longer exists in Notion.

## After the run

Reload the side panel and open a WOCOO ticket whose work type you just synced. The
verdict card should cite the playbook content in its steps or gotchas.
