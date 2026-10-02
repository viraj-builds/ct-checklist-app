"use client";

// Upload a file straight to Supabase Storage with a one-time signed URL (the
// file never passes through our API routes). XHR is used for progress events.
export function uploadToSignedUrl(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("cacheControl", "60");
    form.append("", file);

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-upsert", "false");
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (key) xhr.setRequestHeader("apikey", key);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Upload failed (${xhr.status})`;
      try {
        const j = JSON.parse(xhr.responseText);
        msg = j.message ?? j.error ?? msg;
      } catch {
        /* ignore */
      }
      if (xhr.status === 413 || /maximum allowed size|too large/i.test(msg))
        msg = "The file is larger than the storage upload limit. Use “Private scan” instead — it has no size limit.";
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.send(form);
  });
}
