// Every Preset workspace, database, dataset and dashboard id Sidekick depends on, in one
// place so the Redshift → Snowflake migration (new workspace and/or re-created assets) is a
// one-file edit. Dashboard URLs stay bare — no `native_filters_key`, per
// [[preset-native-filters-key]]: the content script can't clear chips baked into that param.

export const PRESET_BASE = 'https://784ac929.wealthsimple-aws-mpc.app.preset.io';

/** SQL Lab database Insurance Eligibility runs against (Snowflake_pantheon_db). */
export const WAREHOUSE_DATABASE_ID = 1;

/** "ALL wire sends created" dataset behind chart 29563 on Wire Send Monitoring (836). */
export const WIRE_SENDS_DATASET_ID = 11961;

export const PRESET_DASHBOARD_IDS = {
  overpayment: 227,
  // Old 8324 "Cash & Card Ops: Direct Deposit Details" has no Snowflake counterpart yet.
  verifyEligibleDd: [626],
  visaCompanionRpin: 367,
  walletTriage: 213,
} as const;

export function presetDashboardUrl(id: number): string {
  return `${PRESET_BASE}/superset/dashboard/${id}/`;
}
