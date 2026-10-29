// CleverTap test projects use the live project's style of ID with a "TEST-"
// prefix (TEST-468-W87-546Z). Apps and sites send the full ID; people often
// type it without the prefix. Treat both spellings as the same project.

export const isTestAccount = (id?: string | null) => /^TEST-/i.test((id ?? "").trim());

/** Project ID without the TEST- prefix, upper-cased — for comparisons only. */
export const accountKey = (id: string) => id.trim().toUpperCase().replace(/^TEST-/, "");

export const sameAccount = (a: string, b: string) => accountKey(a) === accountKey(b);

/** The other spelling: adds TEST- if missing, removes it if present. */
export const otherAccountSpelling = (id: string) => (isTestAccount(id) ? id.trim().replace(/^TEST-/i, "") : `TEST-${id.trim()}`);
