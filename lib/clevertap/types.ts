// Output of the CleverTap API verifier. Stored on the audit (never contains
// the passcode). Everything is derived from small samples of the Get Events /
// Get Profiles APIs — "sampled" counts are lower bounds, not totals.

export interface EventSample {
  name: string;
  windowDays: number;
  sampled: number; // records returned (capped by batch size)
  androidSampled: number;
  capped: boolean; // true when the sample hit the batch limit (= "at least")
  lastSeen?: string; // yyyyMMddHHmmss of the newest sampled record
  error?: string;
  props?: Record<string, PropStats>;
}

export interface PropStats {
  types: Partial<Record<"string" | "number" | "boolean" | "date" | "array" | "nullish", number>>;
  examples: string[]; // a few distinct values (truncated)
  numericStrings: number; // "199" sent as a string
  dateLikeStrings: number; // "2020-04-22" / "22/04/2020" sent as a string
}

export interface ProfileSample {
  source: string; // which event the profiles came from
  sampled: number;
  android: number;
  withIdentity: number;
  withEmail: number;
  withPhone: number;
  phoneValid: number;
  phoneInvalidExamples: string[]; // masked
  anonymous: number; // no identity, email or phone
  nullishFields: string[]; // profile fields carrying "null" / "" / "undefined"
  dateLikeStringFields: string[]; // DOB etc. sent as plain strings
  withPushToken?: number; // from Get Profiles platformInfo
  pushTokenSampled?: number;
  appVersions?: Record<string, number>;
}

export interface ApiFindings {
  ok: boolean;
  error?: string;
  errorKind?: "auth" | "region" | "network" | "limit" | "unknown";
  region: string;
  checkedAt: number;
  durationMs: number;
  events: Record<string, EventSample>; // keyed by event name
  profiles?: ProfileSample;
  customEvents: string[]; // names that were checked as custom events
  testPush?: TestPushRecord;
}

export interface TestPushRecord {
  identity: string; // masked
  sentAt: number;
  channelId?: string;
  deepLink?: string;
  status: "sent" | "confirmed" | "not-confirmed" | "failed";
  message?: string;
  confirmedAt?: number;
  clicked?: boolean;
}
