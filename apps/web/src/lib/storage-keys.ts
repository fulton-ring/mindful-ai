/**
 * Every browser storage key the web app reads or writes. Account deletion clears
 * everything under STORAGE_PREFIX, so new keys must keep it.
 */
export const STORAGE_PREFIX = 'walden:';

const DRAFT_PREFIX = `${STORAGE_PREFIX}draft:`;
/** Retired per-note proposal cache; still cleared when the signed-in identity changes. */
const LEGACY_PROPOSAL_PREFIX = `${STORAGE_PREFIX}proposal:`;

export const storageKeys = {
  /** sessionStorage: the identity the per-session caches below belong to. */
  identity: `${STORAGE_PREFIX}identity`,
  /** localStorage */
  lastNote: `${STORAGE_PREFIX}last-note`,
  noteWidth: `${STORAGE_PREFIX}note-width`,
  sidebarWidth: `${STORAGE_PREFIX}sidebar-width`,
  theme: `${STORAGE_PREFIX}theme`,
  authSession: `${STORAGE_PREFIX}auth-session`,
  browserAnalytics: `${STORAGE_PREFIX}browser-analytics`,
  persona: (identity: string) => `${STORAGE_PREFIX}persona:${identity}`,
  /** sessionStorage */
  draft: (noteId: string) => `${DRAFT_PREFIX}${noteId}`,
  closedNotes: (identity: string | undefined) => `${STORAGE_PREFIX}closed-notes:${identity ?? ''}`,
};

/** sessionStorage keys that hold one identity's unsaved note work. */
export function isIdentityScopedDraftKey(key: string) {
  return key.startsWith(DRAFT_PREFIX) || key.startsWith(LEGACY_PROPOSAL_PREFIX);
}
