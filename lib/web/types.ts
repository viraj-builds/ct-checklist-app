// Output of the website crawler (lib/web/crawler.ts). Stored on the audit in the
// `scan` column. It never contains the test login's password, and identity /
// email / phone values are masked before they are stored.

export type ValueType = "string" | "number" | "boolean" | "date" | "array" | "object" | "nullish";

/** One property of an event or profile push, as the SDK sent it. */
export interface WebProp {
  type: ValueType;
  example?: string; // masked for identity / email / phone
  issue?: string; // e.g. 'empty / "null"', "number sent as text", "date sent as text"
}

export interface WebEvent {
  name: string;
  count: number;
  page: string; // path where it was first seen
  props: Record<string, WebProp>;
  issues: string[];
}

export interface WebProfilePush {
  via: "onUserLogin" | "profile" | "unknown"; // from the API hook; "unknown" = seen only on the network
  phase: "anonymous" | "login" | "revisit" | "browse";
  hasIdentity: boolean;
  hasEmail: boolean;
  phone?: string; // masked
  phoneValid?: boolean;
  keys: string[];
  props: Record<string, WebProp>;
  issues: string[];
}

export interface CodeUsage {
  found: boolean;
  count: number;
  evidence: string[]; // short snippets around the call
}

export interface WebScanReport {
  schema: 1;
  platform: "web";
  analyzer: string;
  url: string; // what the user gave
  finalUrl: string; // after redirects
  scannedAt: number;
  durationMs: number;
  page: {
    title?: string;
    status?: number;
    https: boolean;
    manifest?: string; // <link rel="manifest"> href
  };
  sdk: {
    present: boolean;
    // head = snippet / script tag inside <head>; body = script tag after <head>;
    // bundle = installed from npm (clevertap-web-sdk) inside the site's JS
    loading: "head" | "body" | "bundle" | "none";
    scriptUrl?: string;
    version?: string; // e.g. 2.7.3
    accountId?: string; // from the requests the SDK sent
    region?: string; // eu1, in1 … from the request host
    host?: string; // eu1.clevertap-prod.com
    firstRequestMs?: number; // time from navigation to the first CleverTap request
    spa?: boolean;
    debugLogs: boolean; // the SDK printed its verbose logs (WZRK_D)
  };
  network: {
    requests: number;
    accepted: number; // 2xx responses from CleverTap
    failed: number;
    errors: string[]; // e.g. "account blocked" responses, failed requests
    webPushConfigured: boolean; // CleverTap answered with enableWebPush(...) = web push channel set up on the dashboard
  };
  ctId?: string; // the anonymous CleverTap ID the crawler's browser got
  ctIdAfterLogin?: string;
  privacy: {
    called: boolean;
    optOut?: boolean;
    useIP?: boolean;
    getLocation: boolean; // clevertap.getLocation() used
  };
  utm: {
    tested: boolean;
    params: { source: string; medium: string; campaign: string };
    sent: boolean; // a page request carried us / um / uc
    landedOn?: string; // where the UTM landing ended up (a redirect can drop the parameters)
  };
  webPush: {
    promptCalled: boolean; // clevertap.notifications.push(...)
    serviceWorkerPath: string;
    serviceWorker: { status?: number; reachable: boolean; clevertap: boolean; imports?: string };
    registered?: string; // scriptURL of the service worker registered with permission granted
    vapidKey: boolean;
    softPrompt?: boolean; // the SDK asked for its own dialog (not skipDialog)
  };
  code: {
    scannedFiles: number;
    scannedBytes: number;
    onUserLogin: CodeUsage;
    profilePush: CodeUsage;
    eventPush: CodeUsage;
    privacy: CodeUsage;
    notifications: CodeUsage;
    getLocation: CodeUsage;
    setLogLevel: CodeUsage;
  };
  calls: { api: "onUserLogin" | "profile" | "event" | "notifications" | "privacy"; phase: WebProfilePush["phase"]; at: number }[];
  eventNames: string[]; // custom event names found in the site's code
  events: WebEvent[]; // custom events the crawler saw being sent
  systemEvents: string[];
  profiles: WebProfilePush[];
  login: {
    attempted: boolean;
    ok?: boolean;
    url?: string;
    message?: string;
    identityChanged?: boolean; // the CleverTap ID switched (an existing profile was found for this user)
    revisit?: { onUserLogin: boolean; identified: boolean; checked: boolean };
  };
  pages: string[]; // paths visited
  notes: string[];
}

/** One test push watched end-to-end in the live Chrome session. */
export interface LivePushTest {
  sentAt: number;
  deepLink?: string;
  receivedAt?: number; // CleverTap's service worker got the push ("Push event")
  viewedAt?: number; // the service worker reported Notification Viewed to CleverTap
  shownAt?: number; // the notification was on screen (registration.getNotifications)
  clickedAt?: number; // the service worker handled a click
  landedUrl?: string; // page that opened after the click
}

/**
 * What the live session in the user's own Chrome saw (public/ct-web-bridge.mjs).
 * Built in the browser from the helper's raw events; identity / email / phone are
 * masked before this is saved.
 */
export interface WebLiveFindings {
  schema: 1;
  device: "desktop" | "android";
  browser?: string; // e.g. "Chrome/141.0.7390.65"
  url: string;
  startedAt: number;
  updatedAt: number;
  sdk: { present: boolean; version?: string; accountId?: string; region?: string; host?: string; debugLogs: boolean };
  network: { requests: number; accepted: number; webPushConfigured: boolean };
  ctId?: string;
  utm: { tested: boolean; sent: boolean };
  login: { seen: boolean; at?: number; via?: "onUserLogin" | "profile" | "unknown" };
  revisit?: { at: number; onUserLogin: boolean; identified: boolean };
  profiles: WebProfilePush[];
  events: WebEvent[];
  calls: { api: "onUserLogin" | "profile" | "event" | "notifications" | "privacy"; phase: WebProfilePush["phase"]; at: number }[];
  pages: string[];
  push: {
    permission?: "default" | "granted" | "denied";
    subscribed: boolean; // a push subscription exists for the site
    serviceWorker?: string;
    tests: Partial<Record<"push" | "deeplink", LivePushTest>>;
  };
}
