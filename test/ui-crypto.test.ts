/**
 * Browser crypto primitives (ui/src/lib): base64url, canonical strings, SHA-256 with midstate and the
 * PKCS#8 PEM reader. They are checked against the server's own functions (src/schema.ts), against
 * crypto.subtle, and against the SKILL.md test vectors, so the browser and the Worker cannot drift.
 */
import { describe, expect, it } from "vitest";
import {
  decodeBase64url as serverDecode,
  encodeBase64url as serverEncode,
  powPreimage as serverPowPreimage,
  registrationSigningString as serverRegistrationSigningString,
  requestSigningString as serverRequestSigningString,
  sha256Hex as serverSha256Hex,
  verifyEd25519,
} from "../src/schema";
import { base64urlLength, decodeBase64url, encodeBase64url, isCanonicalBase64url } from "../ui/src/lib/base64url";
import {
  EMPTY_BODY_SHA256_HEX,
  POW_ALGORITHM,
  REGISTRATION_SIGNING_CONTEXT,
  REQUEST_SIGNING_CONTEXT,
  powPreimage,
  registrationSigningString,
  requestSigningString,
  utf8,
} from "../ui/src/lib/canonical";
import {
  ED25519_PKCS8_LENGTH,
  ED25519_PKCS8_PREFIX,
  PemError,
  ed25519SeedFromPkcs8,
  parsePkcs8Pem,
} from "../ui/src/lib/pem";
import {
  bytesToHex,
  createSuffixHasher,
  sha256,
  sha256Finish,
  sha256Hex,
  sha256Midstate,
  sha256WordsToBytes,
} from "../ui/src/lib/sha256";

// The vectors printed in SKILL.md section 8.
const SEED_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const PUBLIC_KEY = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";
const CHALLENGE = "EoI8yTsHQvEUsyaAHydHIjYhx8tIlHh26aHmIaKqZlQ";
const NONCE = "7549";
const DIGEST = "0000646354041268aa8fbf9d704f08bf54591d4f0247fef3b95ec8a117c257ec";
const PROOF_SIGNATURE = "fIR8QjmB7EkuPyozG8Dsd-hgEc24UcedP40EQWv--ik2MHCQoW_i6qjvys2rWTSzjujZ7hQaMeqxXOufej3uCQ";
const BODY =
  '{"domain":"fintech","tool":"transfer_funds","task_description":"Move client funds to the settlement account","arguments":{"amount":50000}}';
const BODY_SHA256 = "91f119d8da6881e815ac07761bfc9b89a3d0289af5dceb724b42926a455bbf88";
const REQUEST_NONCE = "AAECAwQFBgcICQoLDA0ODw";
const REQUEST_SIGNATURE = "mPAMbWJ24bSAseFFTHQL0zo7UcmAb50J9LjFPHU8jxXuweWXE9J9pdzuOQqHMp4801FXi3SSLKHKRRzmB0t9BA";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // getRandomValues is limited to 64 KiB per call.
  for (let offset = 0; offset < length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
  return bytes;
}

async function subtleSha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);

/** An Ed25519 PrivateKeyInfo, as `openssl genpkey -algorithm ed25519` writes it. */
function pkcs8(seed: Uint8Array = SEED): Uint8Array {
  return concat(ED25519_PKCS8_PREFIX, seed);
}

function toPem(der: Uint8Array, options: { width?: number; eol?: string; label?: string } = {}): string {
  const { width = 64, eol = "\n", label = "PRIVATE KEY" } = options;
  const body = btoa(String.fromCharCode(...der));
  const lines = body.match(new RegExp(`.{1,${width}}`, "g")) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join(eol) + eol;
}

// ════════════════════════════════════════════════════════════════════════
// base64url
// ════════════════════════════════════════════════════════════════════════

describe("base64url", () => {
  it("encodes byte for byte like the server for every length from 0 to 100", () => {
    for (let length = 0; length <= 100; length++) {
      const bytes = randomBytes(length);
      const encoded = encodeBase64url(bytes);
      expect(encoded, `length ${length}`).toBe(serverEncode(bytes));
      expect(encoded.length).toBe(base64urlLength(length));
      expect(encoded).not.toMatch(/[=+/]/);
    }
  });

  it("decodes what the server encodes, and the server decodes what it encodes", () => {
    for (let length = 0; length <= 100; length++) {
      const bytes = randomBytes(length);
      expect(Array.from(decodeBase64url(serverEncode(bytes)))).toEqual(Array.from(bytes));
      expect(Array.from(serverDecode(encodeBase64url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("round-trips the skill.md key sizes: 32 -> 43, 64 -> 86, 16 -> 22 characters", () => {
    for (const [bytes, characters] of [[32, 43], [64, 86], [16, 22]] as const) {
      const encoded = encodeBase64url(randomBytes(bytes));
      expect(encoded).toHaveLength(characters);
      expect(isCanonicalBase64url(encoded, bytes)).toBe(true);
    }
    expect(decodeBase64url(PUBLIC_KEY)).toHaveLength(32);
    expect(encodeBase64url(decodeBase64url(PUBLIC_KEY))).toBe(PUBLIC_KEY);
    expect(decodeBase64url(PROOF_SIGNATURE)).toHaveLength(64);
    expect(encodeBase64url(decodeBase64url(REQUEST_SIGNATURE))).toBe(REQUEST_SIGNATURE);
    expect(decodeBase64url(REQUEST_NONCE)).toHaveLength(16);
    expect(Array.from(decodeBase64url(REQUEST_NONCE))).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("uses the URL-safe alphabet and no padding", () => {
    expect(encodeBase64url(Uint8Array.from([0xfb, 0xff, 0xfe]))).toBe("-__-");
    expect(encodeBase64url(Uint8Array.from([0xff]))).toBe("_w");
    expect(encodeBase64url(new Uint8Array(0))).toBe("");
  });

  it("rejects padding, other alphabets, impossible lengths and non-canonical trailing bits", () => {
    for (const bad of ["AA==", "AA=", "A+A_", "A/A_", "A B_", "AB\n", "é", "A", "AAAAA", "AB", "AAB", "_x", "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbh"]) {
      expect(() => decodeBase64url(bad), JSON.stringify(bad)).toThrow(RangeError);
      expect(isCanonicalBase64url(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isCanonicalBase64url(PUBLIC_KEY, 16)).toBe(false); // right alphabet, wrong size
  });

  it("agrees with the server's canonical rule (re-encoding gives the same string) on random text", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(Math.random() * 12);
      let text = "";
      for (let j = 0; j < length; j++) text += alphabet[Math.floor(Math.random() * alphabet.length)]!;
      let serverCanonical = false;
      if (length % 4 !== 1) {
        try {
          serverCanonical = serverEncode(serverDecode(text)) === text;
        } catch {
          serverCanonical = false;
        }
      }
      expect(isCanonicalBase64url(text), JSON.stringify(text)).toBe(serverCanonical);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// canonical strings
// ════════════════════════════════════════════════════════════════════════

describe("canonical strings", () => {
  it("exposes the server's domain-separation constants", () => {
    expect(REQUEST_SIGNING_CONTEXT).toBe("achromat-mom-v1");
    expect(REGISTRATION_SIGNING_CONTEXT).toBe("achromat-register-v1");
    expect(POW_ALGORITHM).toBe("sha256-hashcash-v1");
  });

  it("builds the request signing string exactly like the server", () => {
    const inputs = [
      { host: "mom.achromat.ai", method: "POST", pathAndQuery: "/api/v1/recall", bodySha256Hex: BODY_SHA256, timestamp: "1790000000", nonce: REQUEST_NONCE },
      { host: "MOM.Achromat.AI", method: "get", pathAndQuery: "/api/v1/agents/me?x=1&y=%20", bodySha256Hex: EMPTY_BODY_SHA256_HEX, timestamp: "1790000001", nonce: "AAAAAAAAAAAAAAAAAAAAAA" },
      { host: "localhost:8787", method: "Post", pathAndQuery: "/api/v1/calibrate", bodySha256Hex: "0".repeat(64), timestamp: "1790000002", nonce: "_-_-_-_-_-_-_-_-_-_-_-" },
    ];
    for (const input of inputs) {
      const ui = requestSigningString(input);
      expect(ui).toBe(serverRequestSigningString(input));
      expect(ui.split("\n")).toHaveLength(7);
      expect(ui.endsWith("\n")).toBe(false);
      expect(ui).not.toContain("\\n");
      expect(ui).not.toContain("\r");
    }
  });

  it("builds the registration signing string and PoW preimage exactly like the server", () => {
    expect(registrationSigningString(CHALLENGE, PUBLIC_KEY)).toBe(serverRegistrationSigningString(CHALLENGE, PUBLIC_KEY));
    expect(registrationSigningString(CHALLENGE, PUBLIC_KEY)).toBe(`achromat-register-v1\n${CHALLENGE}\n${PUBLIC_KEY}`);
    expect(powPreimage(CHALLENGE, PUBLIC_KEY, NONCE)).toBe(serverPowPreimage(CHALLENGE, PUBLIC_KEY, NONCE));
    expect(powPreimage(CHALLENGE, PUBLIC_KEY, NONCE)).toBe(`${CHALLENGE}${PUBLIC_KEY}${NONCE}`);
  });

  it("encodes text as UTF-8", () => {
    expect(Array.from(utf8("é€😀"))).toEqual(Array.from(new TextEncoder().encode("é€😀")));
    expect(utf8("").length).toBe(0);
  });

  it("matches the skill.md request-signature vector: the server verifies the browser-built string", async () => {
    const canonical = requestSigningString({
      host: "mom.achromat.ai",
      method: "POST",
      pathAndQuery: "/api/v1/recall",
      bodySha256Hex: sha256Hex(utf8(BODY)),
      timestamp: "1790000000",
      nonce: REQUEST_NONCE,
    });
    expect(sha256Hex(utf8(BODY))).toBe(BODY_SHA256);
    expect(await verifyEd25519(PUBLIC_KEY, REQUEST_SIGNATURE, canonical)).toBe(true);
    expect(await verifyEd25519(PUBLIC_KEY, PROOF_SIGNATURE, registrationSigningString(CHALLENGE, PUBLIC_KEY))).toBe(true);
  });

  it("reproduces both skill.md signatures byte for byte when signing with Web Crypto from the seed", async () => {
    expect(bytesToHex(SEED)).toBe(SEED_HEX);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8(), { name: "Ed25519" }, false, ["sign"]);
    const canonical = requestSigningString({
      host: "mom.achromat.ai",
      method: "POST",
      pathAndQuery: "/api/v1/recall",
      bodySha256Hex: BODY_SHA256,
      timestamp: "1790000000",
      nonce: REQUEST_NONCE,
    });
    const requestSignature = encodeBase64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(canonical))));
    expect(requestSignature).toBe(REQUEST_SIGNATURE);
    const proof = encodeBase64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(registrationSigningString(CHALLENGE, PUBLIC_KEY)))));
    expect(proof).toBe(PROOF_SIGNATURE);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SHA-256
// ════════════════════════════════════════════════════════════════════════

describe("sha256", () => {
  it("matches the standard vectors and the skill.md digest", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY_BODY_SHA256_HEX);
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex(utf8(powPreimage(CHALLENGE, PUBLIC_KEY, NONCE)))).toBe(DIGEST);
    expect(sha256Hex(utf8(BODY))).toBe(BODY_SHA256);
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("matches crypto.subtle.digest on random inputs of random length", async () => {
    for (let i = 0; i < 300; i++) {
      const data = randomBytes(Math.floor(Math.random() * 400));
      expect(bytesToHex(sha256(data)), `length ${data.length}`).toBe(bytesToHex(await subtleSha256(data)));
    }
  });

  it("matches crypto.subtle.digest around every padding and block boundary", async () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 191, 192, 193, 4096, 100_000]) {
      const data = randomBytes(length);
      expect(sha256Hex(data), `length ${length}`).toBe(bytesToHex(await subtleSha256(data)));
      expect(sha256Hex(data)).toBe(await serverSha256Hex(data));
    }
  });

  it("finishes from a midstate for every prefix and suffix length, leaving the midstate reusable", async () => {
    const prefixLengths = [0, 1, 22, 55, 56, 63, 64, 65, 86, 119, 120, 127, 128, 129, 150, 200];
    const suffixLengths = [0, 1, 4, 8, 9, 22, 23, 33, 34, 41, 42, 55, 56, 63, 64, 65, 80, 128];
    for (const prefixLength of prefixLengths) {
      const prefix = randomBytes(prefixLength);
      const midstate = sha256Midstate(prefix);
      expect(midstate.tail.length).toBe(prefixLength % 64);
      expect(midstate.byteLength).toBe(prefixLength);
      for (const suffixLength of suffixLengths) {
        const suffix = randomBytes(suffixLength);
        const expected = await subtleSha256(concat(prefix, suffix));
        expect(bytesToHex(sha256Finish(midstate, suffix)), `prefix ${prefixLength} suffix ${suffixLength}`).toBe(bytesToHex(expected));
      }
      expect(bytesToHex(sha256Finish(midstate))).toBe(bytesToHex(await subtleSha256(prefix)));
    }
  });

  it("hashes many different suffixes against one prefix with the reusable suffix hasher, in any order", async () => {
    for (const prefixLength of [0, 22, 63, 64, 86, 100, 127, 150]) {
      const prefix = randomBytes(prefixLength);
      const hasher = createSuffixHasher(sha256Midstate(prefix), 80);
      for (let i = 0; i < 120; i++) {
        // Lengths jump up and down so stale marker and length bytes would show up as a wrong digest.
        const length = Math.floor(Math.random() * 81);
        const suffix = randomBytes(80);
        const expected = await subtleSha256(concat(prefix, suffix.subarray(0, length)));
        expect(bytesToHex(sha256WordsToBytes(hasher.hash(suffix, length))), `prefix ${prefixLength} suffix ${length}`).toBe(bytesToHex(expected));
      }
    }
    expect(() => createSuffixHasher(sha256Midstate(new Uint8Array(0)), 4).hash(new Uint8Array(8), 5)).toThrow(RangeError);
  });

  it("reproduces the skill.md Hashcash digest through the same path the PoW search uses", () => {
    const hasher = createSuffixHasher(sha256Midstate(utf8(CHALLENGE + PUBLIC_KEY)), 32);
    const digest = sha256WordsToBytes(hasher.hash(utf8(NONCE), NONCE.length));
    expect(bytesToHex(digest)).toBe(DIGEST);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PEM
// ════════════════════════════════════════════════════════════════════════

describe("PKCS#8 PEM reader", () => {
  it("is the 48-byte Ed25519 PrivateKeyInfo Web Crypto itself exports", async () => {
    const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", generated.privateKey)) as ArrayBuffer);
    expect(der).toHaveLength(ED25519_PKCS8_LENGTH);
    expect(Array.from(der.subarray(0, ED25519_PKCS8_PREFIX.length))).toEqual(Array.from(ED25519_PKCS8_PREFIX));
    expect(Array.from(parsePkcs8Pem(toPem(der)))).toEqual(Array.from(der));
  });

  it("parses the PEM layouts openssl and other tools write", () => {
    const der = pkcs8();
    for (const pem of [
      toPem(der),
      toPem(der, { eol: "\r\n" }),
      toPem(der, { width: 76 }),
      toPem(der, { width: 48 }),
      `\n\n  ${toPem(der)}  \n\n`,
      toPem(der).replace(/\n/g, " \n"),
    ]) {
      expect(Array.from(parsePkcs8Pem(pem))).toEqual(Array.from(der));
    }
    expect(Array.from(ed25519SeedFromPkcs8(parsePkcs8Pem(toPem(der))))).toEqual(Array.from(SEED));
  });

  it("yields a key Web Crypto accepts, and the JWK `x` is the public key the server knows", async () => {
    const der = parsePkcs8Pem(toPem(pkcs8()));
    const extractable = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", extractable)) as JsonWebKey;
    expect(jwk.x).toBe(PUBLIC_KEY);

    const nonExtractable = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    expect(nonExtractable.extractable).toBe(false);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, nonExtractable, utf8("hello")));
    expect(await verifyEd25519(PUBLIC_KEY, encodeBase64url(signature), "hello")).toBe(true);
  });

  it("rejects missing, encrypted, other-type and non-PKCS#8 input with a specific message", () => {
    const der = pkcs8();
    const cases: Array<[string, string, RegExp]> = [
      ["empty", "", /No key provided/],
      ["whitespace", "  \n ", /No key provided/],
      ["encrypted", toPem(der, { label: "ENCRYPTED PRIVATE KEY" }), /encrypted/],
      ["openssh", toPem(der, { label: "OPENSSH PRIVATE KEY" }), /OpenSSH/],
      ["rsa", toPem(der, { label: "RSA PRIVATE KEY" }), /not a PKCS#8 Ed25519/],
      ["ec", toPem(der, { label: "EC PRIVATE KEY" }), /not a PKCS#8 Ed25519/],
      ["public key", toPem(der, { label: "PUBLIC KEY" }), /public key or certificate/],
      ["no armor", btoa(String.fromCharCode(...der)), /BEGIN PRIVATE KEY/],
      ["no footer", toPem(der).replace(/-----END PRIVATE KEY-----\n?/, ""), /END PRIVATE KEY/],
      ["empty body", "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----", /empty/],
    ];
    for (const [label, pem, message] of cases) {
      expect(() => parsePkcs8Pem(pem), label).toThrow(PemError);
      expect(() => parsePkcs8Pem(pem), label).toThrow(message);
    }
  });

  it("rejects text around the block, a second block, PEM headers and blank lines", () => {
    const pem = toPem(pkcs8());
    expect(() => parsePkcs8Pem(`note\n${pem}`)).toThrow(PemError);
    expect(() => parsePkcs8Pem(`${pem}\ntrailing`)).toThrow(PemError);
    expect(() => parsePkcs8Pem(pem + pem)).toThrow(/one key block/);
    expect(() => parsePkcs8Pem(pem.replace("-----BEGIN PRIVATE KEY-----\n", "-----BEGIN PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n"))).toThrow(/headers/);
    expect(() => parsePkcs8Pem(pem.replace("\n", "\n\n"))).toThrow(PemError);
    expect(() => parsePkcs8Pem(toPem(concat(pkcs8(), new Uint8Array(60)), { width: 100 }))).toThrow(/too long/);
  });

  it("rejects malformed and non-canonical base64", () => {
    const lines = toPem(pkcs8()).split("\n");
    const withBody = (body: string) => [lines[0], body, lines[lines.length - 2]].join("\n");
    const good = lines[1]!; // 48 bytes = 64 characters, one line
    expect(good.length % 4).toBe(0);
    for (const [label, body] of [
      ["url-safe alphabet", good.replace(/\+/g, "-").replace(/\//g, "_") + "-"],
      ["whitespace inside a line", good.slice(0, 10) + " " + good.slice(10)],
      ["bad length", good.slice(0, -1)],
      ["padding in the middle", good.slice(0, 8) + "=" + good.slice(9)],
      ["too much padding", good.slice(0, -3) + "==="],
    ] as const) {
      expect(() => parsePkcs8Pem(withBody(body)), label).toThrow(PemError);
    }
    // A padded tail has spare bits that must be zero: "YWI=" is canonical (but not a key), "YWJ=" is not canonical.
    expect(() => parsePkcs8Pem(withBody("YWJ="))).toThrow(/canonical/);
    expect(() => parsePkcs8Pem(withBody("YWI="))).toThrow(/not an Ed25519/);
  });

  it("rejects any DER that is not exactly an Ed25519 PKCS#8 v1 key", () => {
    const der = pkcs8();
    const mutate = (index: number, value: number) => {
      const copy = der.slice();
      copy[index] = value;
      return copy;
    };
    const cases: Array<[string, Uint8Array]> = [
      ["truncated", der.slice(0, 47)],
      ["extended", concat(der, new Uint8Array([0]))],
      ["empty seed area", der.slice(0, 16)],
      ["X25519 OID (1.3.101.110)", mutate(11, 0x6e)],
      ["wrong version", mutate(4, 0x01)],
      ["wrong outer length", mutate(1, 0x2f)],
      ["wrong seed length", mutate(15, 0x1f)],
      ["PKCS#8 v2 (with public key)", concat(Uint8Array.from([0x30, 0x72, 0x02, 0x01, 0x01]), der.slice(5), new Uint8Array(37))],
    ];
    for (const [label, bad] of cases) {
      expect(() => parsePkcs8Pem(toPem(bad)), label).toThrow(PemError);
      expect(() => ed25519SeedFromPkcs8(bad), label).toThrow(PemError);
    }
  });

  it("never echoes key material in an error message", () => {
    const body = toPem(pkcs8(Uint8Array.from({ length: 32 }, () => 0xab))).split("\n")[1]!;
    const attempts = [
      toPem(pkcs8(Uint8Array.from({ length: 32 }, () => 0xab)), { label: "RSA PRIVATE KEY" }),
      toPem(pkcs8(Uint8Array.from({ length: 32 }, () => 0xab)), { width: 100 }).replace("PRIVATE KEY-----\n", "PRIVATE KEY-----\nX: y\n"),
      toPem(concat(pkcs8(Uint8Array.from({ length: 32 }, () => 0xab)), new Uint8Array(1))),
    ];
    for (const pem of attempts) {
      try {
        parsePkcs8Pem(pem);
        throw new Error("expected a failure");
      } catch (error) {
        expect(error).toBeInstanceOf(PemError);
        expect((error as Error).message).not.toContain(body.slice(16, 40));
      }
    }
  });
});
