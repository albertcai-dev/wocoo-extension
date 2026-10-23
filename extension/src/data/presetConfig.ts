// Every Preset workspace, database, dataset and dashboard id Sidekick depends on, in one
// place so the Redshift → Snowflake migration (new workspace and/or re-created assets) is a
// one-file edit. Dashboard URLs stay bare — no `native_filters_key`, per
// [[preset-native-filters-key]]: the content script can't clear chips baked into that param.

export const PRESET_BASE = 'https://8a26d867.wealthsimple-aws-mpc.app.preset.io';

/** SQL Lab database Insurance Eligibility runs against (Pantheon = Redshift today). */
export const WAREHOUSE_DATABASE_ID = 3;

/** "ALL wire sends created" dataset behind chart 86733 on Wire Send Monitoring. */
export const WIRE_SENDS_DATASET_ID = 62667;

export const PRESET_DASHBOARD_IDS = {
  overpayment: 5790,
  verifyEligibleDd: [7320, 8324],
  visaCompanionRpin: 7666,
  walletTriage: 8014,
} as const;

export function presetDashboardUrl(id: number): string {
  return `${PRESET_BASE}/superset/dashboard/${id}/`;
}
