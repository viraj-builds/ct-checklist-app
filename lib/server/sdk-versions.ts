import "server-only";

// Latest published CleverTap SDK versions, fetched from the public registries
// and cached for 6 hours.

export interface LatestVersions {
  android?: string; // com.clevertap.android:clevertap-android-sdk
  flutter?: string; // clevertap_plugin (pub.dev)
  reactNative?: string; // clevertap-react-native (npm)
  cordova?: string; // clevertap-cordova (npm)
  geofence?: string;
  pushTemplates?: string;
  ios?: string; // CleverTap-iOS-SDK (CocoaPods trunk)
  fetchedAt: number;
}

const REVALIDATE = 60 * 60 * 6;

async function maven(artifact: string) {
  const res = await fetch(`https://repo1.maven.org/maven2/com/clevertap/android/${artifact}/maven-metadata.xml`, {
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) return undefined;
  return (await res.text()).match(/<release>([^<]+)<\/release>/)?.[1];
}

async function json<T>(url: string, pick: (j: T) => string | undefined) {
  const res = await fetch(url, { next: { revalidate: REVALIDATE } });
  if (!res.ok) return undefined;
  return pick((await res.json()) as T);
}

// Newest stable CocoaPods release (trunk lists every version; pre-releases skipped).
async function cocoapod(pod: string) {
  return json<{ versions: { name: string }[] }>(`https://trunk.cocoapods.org/api/v1/pods/${pod}`, (j) =>
    j.versions
      .map((v) => v.name)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      })
      .at(-1),
  );
}

/** Latest iOS SDK version; separate from getLatestVersions so Android audits never wait on it. */
export async function getLatestIosVersion(): Promise<string | undefined> {
  return cocoapod("CleverTap-iOS-SDK").catch(() => undefined);
}

/** Latest Web SDK (clevertap-web-sdk on npm). */
export async function getLatestWebVersion(): Promise<string | undefined> {
  return json<{ version: string }>("https://registry.npmjs.org/clevertap-web-sdk/latest", (j) => j.version).catch(() => undefined);
}

export async function getLatestVersions(): Promise<LatestVersions> {
  const settle = <T,>(p: Promise<T>) => p.catch(() => undefined);
  const [android, geofence, pushTemplates, flutter, reactNative, cordova] = await Promise.all([
    settle(maven("clevertap-android-sdk")),
    settle(maven("clevertap-geofence-sdk")),
    settle(maven("push-templates")),
    settle(json<{ latest: { version: string } }>("https://pub.dev/api/packages/clevertap_plugin", (j) => j.latest?.version)),
    settle(json<{ version: string }>("https://registry.npmjs.org/clevertap-react-native/latest", (j) => j.version)),
    settle(json<{ version: string }>("https://registry.npmjs.org/clevertap-cordova/latest", (j) => j.version)),
  ]);
  return { android, geofence, pushTemplates, flutter, reactNative, cordova, fetchedAt: Date.now() };
}
