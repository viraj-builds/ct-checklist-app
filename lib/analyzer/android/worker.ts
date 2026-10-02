/// <reference lib="webworker" />
// Runs the Android analyzer off the main thread. The file is read here, inside
// the user's browser — it is never uploaded in "private scan" mode.
import { analyzeAndroid } from "./index";

export type WorkerIn = { file: File };
export type WorkerOut =
  | { type: "progress"; stage: string; pct: number }
  | { type: "done"; report: Awaited<ReturnType<typeof analyzeAndroid>> }
  | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const post = (m: WorkerOut) => ctx.postMessage(m);
  try {
    const { file } = e.data;
    post({ type: "progress", stage: "Reading file", pct: 1 });
    const data = new Uint8Array(await file.arrayBuffer());
    const report = await analyzeAndroid(data, file.name, "browser", (stage, pct) =>
      post({ type: "progress", stage, pct }),
    );
    post({ type: "done", report });
  } catch (err) {
    post({
      type: "error",
      message:
        err instanceof Error && /invalid zip|unexpected EOF|end of central directory/i.test(err.message)
          ? "This doesn't look like a valid APK/AAB (couldn't open the zip)."
          : err instanceof Error
            ? err.message
            : String(err),
    });
  }
};
