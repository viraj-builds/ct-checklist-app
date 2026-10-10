import type { ChecklistItem } from "./types";

// Plain-language groups for showing checklist items. They replace the C4S
// tier numbers in the UI; the tiers themselves still drive sorting.

export type GroupId = "settings" | "install" | "login" | "events" | "push" | "links";

export const GROUPS: { id: GroupId; name: string; desc: string }[] = [
  { id: "install", name: "Install and launch", desc: "First-launch events, SDK setup, push token and location" },
  { id: "login", name: "Login and profiles", desc: "One clean profile for every person" },
  { id: "events", name: "Events and data", desc: "Your key events, sent in the right format" },
  { id: "push", name: "Push notifications", desc: "With the app open, in the background and closed" },
  { id: "links", name: "Deep links and in-app", desc: "Taps land on the right screen" },
  { id: "settings", name: "Dashboard settings", desc: "Switches on your CleverTap dashboard" },
];

const BY_ID: Record<string, GroupId> = {
  "app-t1-installed": "install",
  "app-t1-launched": "install",
  "app-t1-sdk-version": "install",
  "app-t1-credentials": "install",
  "app-t1-lifecycle": "install",
  "app-t1-device-token": "install",
  "app-t2-gdpr-location": "install",
  "app-t2-lat-long": "install",
  "app-t1-identity": "login",
  "app-t1-onuserlogin": "login",
  "app-t1-onuserlogin-update": "login",
  "app-t2-anon-profile": "login",
  "app-t2-phone-push": "login",
  "app-t1-custom-events": "events",
  "app-t4-formats": "events",
  "app-t4-valid-values": "events",
  "app-t4-critical-events": "events",
  "app-t1-fcm-service": "push",
  "app-t1-channel": "push",
  "app-t3-test-push": "push",
  "app-t3-killed": "push",
  "app-t3-background": "push",
  "app-t3-foreground": "push",
  "app-t3-impressions": "push",
  "app-t3-post-notifications": "push",
  "app-t3-deeplink-internal": "links",
  "app-t3-deeplink-external": "links",
  "app-t3-test-inapp": "links",
  "app-t3-inapp-exclude": "links",
  "app-t3-uninstall": "settings",
  "app-t3-session-analytics": "settings",
  "web-t1-sdk-head": "install",
  "web-t1-gdpr": "install",
  "web-t1-utm": "install",
  "web-t2-identity": "login",
  "web-t2-onuserlogin": "login",
  "web-t2-profile-push": "login",
  "web-t2-anon": "login",
  "web-t2-onuserlogin-existing": "login",
  "web-t2-phone": "login",
  "web-t3-custom-events": "events",
  "web-t3-web-push": "push",
  "web-t3-deeplink": "links",
};

const BY_TIER: Record<number, GroupId> = { 1: "install", 2: "login", 3: "push", 4: "events" };

export function groupOf(item: ChecklistItem): GroupId {
  return BY_ID[item.id] ?? BY_TIER[item.tier] ?? "install";
}

export function groupName(id: GroupId): string {
  return GROUPS.find((g) => g.id === id)?.name ?? id;
}
