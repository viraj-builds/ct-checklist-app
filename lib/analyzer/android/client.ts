"use client";

import type { AndroidScanReport } from "../types";
import type { WorkerIn, WorkerOut } from "./worker";

/** Analyse an APK/AAB in a Web Worker. Resolves with the JSON report. */
export function scanInBrowser(file: File, onProgress: (stage: string, pct: number) => void): Promise<AndroidScanReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.stage, m.pct);
      else {
        worker.terminate();
        if (m.type === "done") resolve(m.report);
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "The scanner crashed — the file may be too large for this browser."));
    };
    worker.postMessage({ file } satisfies WorkerIn);
  });
}
