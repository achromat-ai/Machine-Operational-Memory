import { describe, expect, it } from "vitest";
import devsecopsMarkdown from "../public/devsecops.md";
import fintechMarkdown from "../public/fintech.md";
import industrialIotMarkdown from "../public/industrial_iot.md";
import skillMarkdown from "../SKILL.md";
import {
  REQUEST_SIGNING_CONTEXT,
  REGISTRATION_SIGNING_CONTEXT,
  leadingZeroBits,
  powPreimage,
  registrationSigningString,
  requestSigningString,
  sha256Hex,
  verifyEd25519,
} from "../src/schema";
import { parseRef } from "../src/telemetry";
import { FEED_LESSON_PATH } from "../src/routes/feed";
import { lessonIdFromHash } from "../ui/src/lib/lessonText";
import { call } from "./helpers";

describe("GET /skill.md", () => {
  it("serves the protocol as plain text (shown inline by browsers), publicly and with the security headers", async () => {
    const response = await call("/skill.md");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = await response.text();
    expect(body).toBe(skillMarkdown);
    expect(body.startsWith("---\nname: achromat-mom\n")).toBe(true);
  });

  it("answers HEAD without a body, and nothing else on that path", async () => {
    const head = await call("/skill.md", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await head.text()).toBe("");
    expect((await call("/skill.md", { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("the domain references", () => {
  const DOMAIN_DOCS = [
    ["/fintech.md", fintechMarkdown, "achromat-mom-fintech"],
    ["/industrial_iot.md", industrialIotMarkdown, "achromat-mom-industrial-iot"],
    ["/devsecops.md", devsecopsMarkdown, "achromat-mom-devsecops"],
  ] as const;

  it("are served as plain text, publicly cacheable, with the same headers as the core protocol", async () => {
    const core = await call("/skill.md");
    for (const [path, markdown, name] of DOMAIN_DOCS) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("Cache-Control"), path).toBe("public, max-age=300");
      expect(response.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(response.headers.get("Content-Security-Policy"), path).toBe(core.headers.get("Content-Security-Policy"));
      const body = await response.text();
      expect(body, path).toBe(markdown);
      expect(body.startsWith(`---\nname: ${name}\n`), path).toBe(true);
    }
  });

  it("answer HEAD without a body, and refuse other methods", async () => {
    for (const [path] of DOMAIN_DOCS) {
      const head = await call(path, { method: "HEAD" });
      expect(head.status, path).toBe(200);
      expect(head.headers.get("Content-Type"), path).toBe("text/plain; charset=utf-8");
      expect(await head.text(), path).toBe("");
      expect((await call(path, { method: "POST", body: "{}" })).status, path).toBe(404);
    }
  });

  it("are distinct documents, and a path that is not one of them is not served", async () => {
    expect(new Set([skillMarkdown, ...DOMAIN_DOCS.map(([, markdown]) => markdown)]).size).toBe(4);
    expect((await call("/robotics.md")).status).not.toBe(200);
    expect((await call("/fintech.md/extra")).status).not.toBe(200);
  });
});

/**
 * The vectors printed in skill.md section 6. They are checked against the server's own functions, so the
 * document cannot drift from the code that validates it.
 */
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
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("skill.md contracts match the server", () => {
  it("prints every test vector verbatim", () => {
    for (const value of [SEED_HEX, PUBLIC_KEY, CHALLENGE, NONCE, DIGEST, PROOF_SIGNATURE, BODY, BODY_SHA256, REQUEST_NONCE, REQUEST_SIGNATURE, EMPTY_SHA256]) {
      expect(skillMarkdown, value).toContain(value);
    }
    expect(skillMarkdown).toContain(`preimage (UTF-8)  ${powPreimage(CHALLENGE, PUBLIC_KEY, NONCE)}`);
    expect(skillMarkdown).toContain(`${REQUEST_SIGNING_CONTEXT}\n{host}\n{METHOD}\n{path_and_query}\n{body_sha256_hex}\n{timestamp}\n{nonce}`);
    expect(skillMarkdown).toContain(REGISTRATION_SIGNING_CONTEXT);
  });

  it("proof of work: the documented preimage hashes to the documented digest and meets the difficulty", async () => {
    const preimage = powPreimage(CHALLENGE, PUBLIC_KEY, NONCE);
    expect(preimage).toBe(CHALLENGE + PUBLIC_KEY + NONCE); // no separator
    const digest = await sha256Hex(preimage);
    expect(digest).toBe(DIGEST);
    expect(leadingZeroBits(digest)).toBe(17);
    // The bit counter agrees with a byte-wise count over the raw digest.
    let bits = 0;
    for (const byte of Uint8Array.from(digest.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))) {
      if (byte === 0) {
        bits += 8;
        continue;
      }
      bits += 8 - byte.toString(2).length;
      break;
    }
    expect(bits).toBe(17);
  });

  it("proof of possession: the documented signature verifies over achromat-register-v1 LF challenge LF key", async () => {
    const message = registrationSigningString(CHALLENGE, PUBLIC_KEY);
    expect(message).toBe(`achromat-register-v1\n${CHALLENGE}\n${PUBLIC_KEY}`);
    expect(await verifyEd25519(PUBLIC_KEY, PROOF_SIGNATURE, message)).toBe(true);
    // The two-character backslash-n variant that agents get wrong must NOT verify.
    expect(await verifyEd25519(PUBLIC_KEY, PROOF_SIGNATURE, `achromat-register-v1\\n${CHALLENGE}\\n${PUBLIC_KEY}`)).toBe(false);
  });

  it("request signing: the documented seven-part string and signature verify", async () => {
    expect(await sha256Hex(BODY)).toBe(BODY_SHA256);
    expect(await sha256Hex("")).toBe(EMPTY_SHA256);
    const canonical = requestSigningString({
      host: "mom.achromat.ai",
      method: "POST",
      pathAndQuery: "/api/v1/recall",
      bodySha256Hex: BODY_SHA256,
      timestamp: "1790000000",
      nonce: REQUEST_NONCE,
    });
    expect(canonical.split("\n")).toEqual([
      "achromat-mom-v1",
      "mom.achromat.ai",
      "POST",
      "/api/v1/recall",
      BODY_SHA256,
      "1790000000",
      REQUEST_NONCE,
    ]);
    expect(canonical.endsWith("\n")).toBe(false);
    expect(await verifyEd25519(PUBLIC_KEY, REQUEST_SIGNATURE, canonical)).toBe(true);
    // A different body, host or method breaks it.
    expect(await verifyEd25519(PUBLIC_KEY, REQUEST_SIGNATURE, canonical.replace("POST", "GET"))).toBe(false);
    expect(await verifyEd25519(PUBLIC_KEY, REQUEST_SIGNATURE, canonical.replace("mom.achromat.ai", "example.com"))).toBe(false);
  });

  it("documents the recall field names the server actually accepts", () => {
    expect(skillMarkdown).toContain('"tool": "<tool>"');
    expect(skillMarkdown).toContain("The field is `tool`, not `tool_name`.");
    expect(skillMarkdown).toContain("compliant_arguments");
    expect(skillMarkdown).toContain("steering_directive");
  });
});

describe("skill.md: citing the lesson (section 4.6)", () => {
  const LINE = "Tool arguments follow a verified Achromat MOM lesson: https://mom.achromat.ai/?ref=audit#lesson-<lesson_id>";

  it("prints the exact citation line and the helper that builds it", () => {
    expect(skillMarkdown).toContain("### 4.6 Citing the lesson");
    expect(skillMarkdown).toContain(LINE);
    expect(skillMarkdown).toContain("def citation_line(lesson: dict) -> str | None:");
    expect(skillMarkdown).toContain('f"Tool arguments follow a verified Achromat MOM lesson: https://mom.achromat.ai/?ref=audit#lesson-{lesson_id}"');
    expect(skillMarkdown).toContain("5. Cite the lesson in your output (section 4.6).");
  });

  it("restricts the line to approved lessons, to human-readable text, and allows opting out", () => {
    expect(skillMarkdown).toContain('`review_status` is `"approved"`');
    expect(skillMarkdown).toContain("A `pending` lesson is private to the key that submitted it");
    expect(skillMarkdown).toMatch(/\*\*Never\*\* put it in the arguments of the tool call/);
    expect(skillMarkdown).toContain("Skip the line if your operator tells you not to add attribution");
  });

  it("does not claim more than the service checks: it says the arguments follow a verified lesson", () => {
    expect(skillMarkdown).not.toContain("Security constraint verified");
    expect(skillMarkdown).not.toMatch(/verified by Achromat MOM/i);
  });

  it("builds a link the service and the page both understand: a valid ref, a path the Worker serves, a fragment the SPA opens", () => {
    const id = crypto.randomUUID();
    const url = new URL(`https://mom.achromat.ai/?ref=audit#lesson-${id}`);
    expect(parseRef(url.searchParams.get("ref"))).toBe("audit"); // the ref survives the server's own slug rule
    expect(lessonIdFromHash(url.hash)).toBe(id); // and the page opens exactly that lesson
    expect(FEED_LESSON_PATH.test(`/api/v1/feed/${id}`)).toBe(true); // which it fetches from this public path
  });

  it("is referred to from each domain reference, without repeating the wording", () => {
    for (const [name, text] of [["fintech.md", fintechMarkdown], ["industrial_iot.md", industrialIotMarkdown], ["devsecops.md", devsecopsMarkdown]] as const) {
      expect(text, name).toContain("and cite it in your output (core protocol, section 4.6)");
      expect(text, name).not.toContain("Tool arguments follow a verified");
    }
  });
});
