export const ATLAS_PHONE_SEARCH_ENABLED = false;
export interface AtlasPhoneHit { identityId: string; firstName: string; lastName: string; email: string | null }
export async function searchAtlasByPhone(_phone: string): Promise<AtlasPhoneHit[]> {
  return [];
}
