/**
 * Caller network identity for the onboarding endpoints.
 *
 * Challenges are bound to the caller's network prefix (/24 for IPv4, /48 for
 * IPv6), and registration caps count per prefix. Raw IPs are never stored: only
 * base64url(HMAC-SHA256(IP_HMAC_KEY, "achromat-ip-prefix-v1\n" + prefix)).
 */
import { encodeBase64url } from "./schema";

function parseIPv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** Expands an IPv6 address (with optional "::", embedded IPv4 tail and zone id) to eight 16-bit groups. */
function parseIPv6(value: string): number[] | null {
  const address = value.split("%")[0] ?? "";
  if (!address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIPv4(piece);
        if (!v4) return null;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        groups.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** "/24" or "/48" prefix of a client IP, or null if the value is not an IP address. */
export function networkPrefix(ip: string): string | null {
  const trimmed = ip.trim();
  const v4 = parseIPv4(trimmed);
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;

  const groups = parseIPv6(trimmed);
  if (!groups) return null;
  // IPv4-mapped (::ffff:a.b.c.d) counts as the IPv4 network it maps.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6]!;
    const low = groups[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.0/24`;
  }
  return `${groups.slice(0, 3).map((group) => group.toString(16)).join(":")}::/48`;
}

export interface CallerNetwork {
  prefixHmac: string;
  asn: number | null;
}

/**
 * Resolves the caller network from CF-Connecting-IP. Returns null when the header is missing or is not an IP
 * (callers fail closed). Throws if `ipHmacKey` is missing or too short.
 */
export async function callerNetwork(request: Request, ipHmacKey: string | undefined): Promise<CallerNetwork | null> {
  const prefix = networkPrefix(request.headers.get("cf-connecting-ip") ?? "");
  if (prefix === null) return null;
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const asn = typeof cf?.asn === "number" ? cf.asn : null;
  return { prefixHmac: await networkPrefixHmac(ipHmacKey, prefix), asn };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

/** Shortest accepted IP_HMAC_KEY (32 characters of base64 ≈ 192 bits). */
const MIN_SECRET_LENGTH = 32;

/** 43-character base64url HMAC of a network prefix. Throws if IP_HMAC_KEY is missing or short (fails closed). */
export async function networkPrefixHmac(secret: string | undefined, prefix: string): Promise<string> {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error("IP_HMAC_KEY is not configured");
  }
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`achromat-ip-prefix-v1\n${prefix}`),
  );
  return encodeBase64url(new Uint8Array(mac));
}
