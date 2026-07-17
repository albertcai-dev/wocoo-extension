// Daily 9 AM Mobile Cheque Validation scheduler.
//
// Architecture: one-shot chrome.alarms entries, re-scheduled inside the alarm
// handler. Avoids the DST drift you'd get from a 24h-period repeating alarm
// (Chrome's repeat math is pure 1440-minute counting, which slides across DST
// changes). Catch-up runs on extension startup if the local-time 9 AM gate has
// already passed today and the bridge has no record for today yet.

import {
  runMobileChequeValidationViaBridge,
  getMobileChequeValidationStatusViaBridge,
} from '../api/bridge';

export const MCV_ALARM_NAME = 'mcv-daily-9am';

const MCV_HOUR_LOCAL = 9;

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-mcv-scheduler]', msg, ...args);
}

/** Compute the timestamp (ms since epoch) of the next 9 AM in the browser's
 *  local time. If it's already past 9 AM today, returns tomorrow's 9 AM. */
function nextLocalNineAM(now: Date = new Date()): number {
  const target = new Date(now);
  target.setHours(MCV_HOUR_LOCAL, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/** Schedule a single chrome.alarms entry at the next 9 AM local. Idempotent —
 *  if an alarm with the same name already exists at the right time, this is a
 *  no-op equivalent (chrome.alarms.create replaces by name). */
export async function scheduleNextMcvAlarm(): Promise<void> {
  const when = nextLocalNineAM();
  await chrome.alarms.create(MCV_ALARM_NAME, { when });
  log('scheduled next MCV alarm at', new Date(when).toString());
}

/** Run the MCV bridge call now. Errors are logged but not re-thrown — the
 *  service worker shouldn't crash because the bridge timed out. */
async function safeRunMcv(reason: string): Promise<void> {
  try {
    log('running MCV (' + reason + ')');
    const record = await runMobileChequeValidationViaBridge();
    log('MCV run complete (' + reason + ')', { status: record.status, date: record.date });
  } catch (e) {
    log('MCV run failed (' + reason + ')', e);
  }
}

/** Handle the 9 AM alarm firing. Runs the bridge then re-schedules tomorrow. */
export async function handleMcvAlarm(): Promise<void> {
  await safeRunMcv('alarm');
  await scheduleNextMcvAlarm();
}

/** Catch-up: if the local-time 9 AM gate has passed today and the bridge has
 *  no record for today, trigger a run. Safe to call multiple times — the
 *  bridge's status check is cheap and only kicks off a fresh run when needed. */
export async function runMcvIfMissed(): Promise<void> {
  const now = new Date();
  if (now.getHours() < MCV_HOUR_LOCAL) {
    log('catch-up skipped — before 9 AM local');
    return;
  }
  try {
    const status = await getMobileChequeValidationStatusViaBridge();
    if (status.record) {
      log('catch-up skipped — record already exists for', status.dateKey);
      return;
    }
    log('catch-up triggered — no record for today (' + status.dateKey + ')');
    await safeRunMcv('catch-up');
  } catch (e) {
    log('catch-up status check failed', e);
  }
}
