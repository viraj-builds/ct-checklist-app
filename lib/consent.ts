// Data & privacy consent for an audit. Shown before an audit starts, stored on
// the audit, and required by every route that saves data captured from a test
// device, website or browser. Bump CONSENT_VERSION when the notice changes.

export const CONSENT_VERSION = 1;

export interface Consent {
  version: number;
  dataCapture: true; // required
  screenshots: boolean; // optional, off unless the user opts in
  at: number; // epoch ms
  by?: string; // who agreed
}

/** What the audit reads — the short form shown next to the checkbox. */
export const CONSENT_POINTS: string[] = [
  "Your build is analysed in your browser; an uploaded build is deleted right after analysis (within an hour at most).",
  "With your passcode we read your CleverTap project (read-only). The only thing we send is a test push you ask for.",
  "While you test, we read what the CleverTap SDK sends — event and property names, data types and whether values are valid. Emails and phone numbers are masked; from phones we keep names and types, not values.",
  "Passcodes and test-account passwords stay in this browser tab and are never stored.",
  "Results stay with this audit until you delete it.",
];

export const SCREENSHOT_POINT =
  "Allow screenshots of the test phone, Simulator or browser to be saved as evidence with this audit (deleted with it). Off by default — nothing is captured unless you tick this.";
