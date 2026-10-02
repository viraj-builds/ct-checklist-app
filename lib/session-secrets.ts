"use client";

// Keeps the CleverTap passcode in memory for the current tab only, so the
// results page can offer "send test push" without asking again. Never written
// to storage — a reload forgets it.
const passcodes = new Map<string, string>();

export const rememberPasscode = (auditId: string, passcode: string) => passcodes.set(auditId, passcode);
export const recallPasscode = (auditId: string) => passcodes.get(auditId);
