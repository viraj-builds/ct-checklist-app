import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// The crawler opens customer-supplied URLs from our server, so it must never be
// pointed at our own network (cloud metadata, localhost, private ranges).
// Every hostname is resolved and each address checked; results are cached for
// the crawl so sub-resource checks stay cheap.

const ALLOW_PRIVATE = process.env.CRAWL_ALLOW_PRIVATE === "1";

function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(ip: string) {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
}

export function isPrivateIp(ip: string) {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v === 6) return privateV6(ip);
  return true;
}

export class UnsafeUrlError extends Error {}

const cache = new Map<string, Promise<boolean>>();

/** true when the host resolves only to public addresses. */
export function isPublicHost(hostname: string): Promise<boolean> {
  if (ALLOW_PRIVATE) return Promise.resolve(true);
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    return Promise.resolve(false);
  if (isIP(host)) return Promise.resolve(!isPrivateIp(host));
  let p = cache.get(host);
  if (!p) {
    p = lookup(host, { all: true, verbatim: true })
      .then((addrs) => addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address)))
      .catch(() => false);
    cache.set(host, p);
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Normalise a user-supplied site URL and make sure it is safe to open. */
export async function assertSafeSiteUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new UnsafeUrlError("That doesn't look like a website address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http(s) websites can be checked.");
  if (url.username || url.password) throw new UnsafeUrlError("Remove the user name / password from the URL.");
  if (url.port && !["80", "443", ""].includes(url.port) && !ALLOW_PRIVATE)
    throw new UnsafeUrlError("Only websites on the standard ports (80 / 443) can be checked.");
  if (!(await isPublicHost(url.hostname)))
    throw new UnsafeUrlError("This address isn't reachable from the internet (private or local network). Use your public / staging URL.");
  return url;
}
