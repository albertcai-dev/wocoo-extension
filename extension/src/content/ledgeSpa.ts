// Ledge SPA content script — serves Wires Pending Posting v2.
//
// Unlike `content/ledge.ts`, this script never touches the page's DOM. The new Ledge
// SPA reads its data from a GraphQL host, so a verify job is one paginated query. What
// the script is here for is the Okta access token: Ledge authenticates with a Bearer
// header, and that token lives in the page's own sessionStorage. A content script
// shares the page's origin, so it can read the token without the side panel ever
// holding it — and sessionStorage is per-tab, which is why the tool opens a tab at all.
//
// Queue protocol matches ledge.ts: the side panel writes one job to
// chrome.storage.local, this script answers on the result key.

import {
  OKTA_TOKEN_STORAGE_KEY,
  PAGE_SIZE,
  fetchAllTransactions,
  fetchTransactionPage,
  matchWireIn,
  readAccessTokenFromOktaStorage,
  transactionWindow,
} from '../data/ledgeGraphql';

export {}; // module scope

const PENDING_KEY = 'pending_ledgespa_verify';
const RESULT_KEY = 'ledgespa_verify_result';
const PROGRESS_KEY = 'ledgespa_in_progress';

interface VerifyJob {
  jobId: string;
  accountNumber: string;
  amount: number;
  currency: string;
  /** Sheet column A display text. Sets the query's start date. */
  wireTimestamp?: string;
}

interface VerifyResult {
  jobId: string;
  matched: boolean;
  reason?: string;
  matchedTransaction?: { effectiveDate: string; description: string; amount: string | number | null };
  scanned?: number;
}

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-ledge-spa]', msg, ...args);
}

async function processJob(job: VerifyJob): Promise<VerifyResult> {
  log('processJob', { jobId: job.jobId, account: job.accountNumber, amount: job.amount });

  const token = readAccessTokenFromOktaStorage(sessionStorage.getItem(OKTA_TOKEN_STORAGE_KEY));
  if (!token) {
    return {
      jobId: job.jobId,
      matched: false,
      reason: 'No Okta access token in this tab — sign in to Ledge, then re-run',
    };
  }

  const accountId = job.accountNumber.trim();
  if (!accountId) {
    return { jobId: job.jobId, matched: false, reason: 'Empty custodian_account_id' };
  }

  const { startDate, endDate } = transactionWindow(job.wireTimestamp || '', new Date());
  const nodes = await fetchAllTransactions((page) =>
    fetchTransactionPage(token, { accountId, startDate, endDate, page, size: PAGE_SIZE }),
  );

  const found = matchWireIn(nodes, job.amount, job.currency);
  if (found) {
    return {
      jobId: job.jobId,
      matched: true,
      scanned: nodes.length,
      matchedTransaction: {
        effectiveDate: found.effectiveDate,
        description: found.description,
        amount: found.credit,
      },
    };
  }

  const amountText = isFinite(job.amount) ? '$' + job.amount.toFixed(2) : 'expected amount';
  return {
    jobId: job.jobId,
    matched: false,
    scanned: nodes.length,
    reason: `Wire not yet posted (no ${amountText} ${job.currency || ''} Wire In row in ${nodes.length} transactions from ${startDate}) — sheet stays Pending posting`,
  };
}

async function pickUpAndProcess(): Promise<void> {
  try {
    const res = await chrome.storage.local.get([PENDING_KEY, PROGRESS_KEY]);
    if (res[PROGRESS_KEY]) return; // already running
    const job = res[PENDING_KEY] as VerifyJob | undefined;
    if (!job || !job.jobId || !job.accountNumber) return;

    await chrome.storage.local.set({ [PROGRESS_KEY]: job.jobId });
    await chrome.storage.local.remove([PENDING_KEY]);

    let result: VerifyResult;
    try {
      result = await processJob(job);
    } catch (e: any) {
      result = { jobId: job.jobId, matched: false, reason: e?.message || String(e) };
    }
    log('result', result);
    await chrome.storage.local.set({ [RESULT_KEY]: result });
    await chrome.storage.local.remove([PROGRESS_KEY]);
  } catch (e: any) {
    // The extension was reloaded while this script kept running on the page; its
    // chrome.* calls now reject. Refreshing the Ledge tab re-attaches the new script.
    if (e?.message?.includes('Extension context invalidated')) {
      log('Extension reloaded — close + reopen this tab to re-attach.');
      return;
    }
    log('pickUpAndProcess error:', e?.message || e);
  }
}

async function bootstrap() {
  log('loaded on', location.href);

  // Clear a stale in-progress flag left by a run whose tab was closed mid-job —
  // otherwise every later job returns early and the side panel just times out.
  const cur = await chrome.storage.local.get(PROGRESS_KEY);
  if (cur[PROGRESS_KEY]) {
    log('Clearing stale in-progress flag:', cur[PROGRESS_KEY]);
    await chrome.storage.local.remove([PROGRESS_KEY]);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (PENDING_KEY in changes) void pickUpAndProcess();
  });
  log('Ready. Listening for', PENDING_KEY);

  // Also poll once on load, in case a job was queued before the script attached.
  await new Promise((r) => setTimeout(r, 500));
  void pickUpAndProcess();
}

void bootstrap();
