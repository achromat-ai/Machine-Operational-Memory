import { describe, expect, it } from "vitest";
import { ibanValid, findPii, luhnValid } from "../src/review/pii";
import { AUDIT_SAMPLE_RATE, auditDraw } from "../src/review/triage";
import { MAX_EMBED_BATCH, embedMany, workersAiEmbedder } from "../src/search/embed";
import {
  EMBEDDING_DIMENSIONS,
  EMBED_MODEL,
  EMBED_VERSION,
  argumentKeyPaths,
  buildIndexText,
  buildQueryText,
  clipToTokens,
  estimateTokens,
} from "../src/search/intent";
import { MAX_UPSERT_BATCH, vectorizeStore, type VectorRecord } from "../src/search/vectors";
import { FakeEmbedder } from "./fixtures/search";

describe("embedding text (decision D6)", () => {
  const input = {
    taskDescription: "Move client funds to the settlement account before the daily cut-off",
    violationRule: "Dual authorisation for large transfers",
    trapArguments: { amount: 50000, currency: "GBP", approval: { second_approver: null } },
    fixArguments: { amount: 50000, currency: "GBP", approval: { second_approver: "ops-lead" }, notes: ["a", { tag: "x" }] },
  };

  it("is the task, the rule and the sorted union of trap and fix key paths: keys, never values", () => {
    expect(buildIndexText(input)).toBe(
      [
        "task: Move client funds to the settlement account before the daily cut-off",
        "rule: Dual authorisation for large transfers",
        "argument_keys: amount approval approval.second_approver currency notes notes.tag",
      ].join("\n"),
    );
    const text = buildIndexText(input);
    for (const value of ["ops-lead", "GBP", "50000"]) expect(text).not.toContain(value);
  });

  it("builds the query from the task and the request's key paths, with no rule line", () => {
    expect(buildQueryText({ taskDescription: "  Move   client funds  ", requestArguments: { amount: 1, nested: { id: "x" } } })).toBe(
      "task: Move client funds\nargument_keys: amount nested nested.id",
    );
  });

  it("names the recipe version", () => {
    expect(EMBED_VERSION).toBe("bge-base-cls/intent-v2");
  });

  it("collapses arrays into their parent path and ignores scalars at the root", () => {
    expect(argumentKeyPaths({ a: [{ b: 1 }, { c: 2 }], d: { e: [] } })).toEqual(["a", "a.b", "a.c", "d", "d.e"]);
    expect(argumentKeyPaths("text")).toEqual([]);
  });
});

describe("token budget (bge accepts 512 tokens; no tokenizer is available)", () => {
  it("keeps the worst realistic index text far below 512 estimated tokens", () => {
    const keys = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`some_long_identifier_name_${i}_with_parts`, 1]));
    const text = buildIndexText({
      taskDescription: "word ".repeat(200),
      violationRule: "rule ".repeat(100),
      trapArguments: keys,
      fixArguments: keys,
    });
    expect(estimateTokens(text)).toBeLessThan(460);
  });

  it("counts every CJK character as a token, so non-Latin text is clipped much sooner", () => {
    const text = buildIndexText({
      taskDescription: "资".repeat(1000),
      violationRule: "规".repeat(300),
      trapArguments: { a: 1 },
      fixArguments: { a: 2 },
    });
    expect(estimateTokens(text)).toBeLessThan(460);
    expect(text.length).toBeLessThan(400);
  });

  it("clips on a piece boundary and never mid-word", () => {
    const clipped = clipToTokens("alpha beta gamma delta epsilon", 4);
    expect(clipped).toBe("alpha beta");
    expect("alpha beta gamma delta epsilon".startsWith(clipped)).toBe(true);
    expect(clipToTokens("short", 100)).toBe("short");
  });

  it("halves every budget on the retry scale", () => {
    const base = { taskDescription: "word ".repeat(200), violationRule: "x", trapArguments: { a: 1 }, fixArguments: { a: 2 } };
    expect(estimateTokens(buildIndexText(base, 0.5))).toBeLessThan(estimateTokens(buildIndexText(base, 1)));
  });
});

describe("Workers AI adapter", () => {
  function fakeAi(shape: (texts: string[]) => unknown) {
    const calls: Array<{ model: string; input: { text: string[]; pooling?: string } }> = [];
    const ai = {
      async run(model: string, input: { text: string[]; pooling?: string }) {
        calls.push({ model, input });
        return shape(input.text);
      },
    } as unknown as Ai;
    return { ai, calls };
  }
  const vectors = (texts: string[]) => ({ shape: [texts.length, EMBEDDING_DIMENSIONS], data: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.5)) });

  it("calls bge-base-en-v1.5 with CLS pooling and splits large inputs into batches", async () => {
    const { ai, calls } = fakeAi(vectors);
    const out = await workersAiEmbedder(ai).embed(Array.from({ length: MAX_EMBED_BATCH * 2 + 3 }, (_, i) => `text ${i}`));
    expect(out).toHaveLength(MAX_EMBED_BATCH * 2 + 3);
    expect(calls.map((call) => call.input.text.length)).toEqual([MAX_EMBED_BATCH, MAX_EMBED_BATCH, 3]);
    expect(calls.every((call) => call.model === EMBED_MODEL && call.input.pooling === "cls")).toBe(true);
  });

  it("rejects wrong shapes instead of storing a bad vector", async () => {
    for (const shape of [() => ({}), () => ({ data: [[1, 2, 3]] }), (t: string[]) => ({ data: t.map(() => new Array(EMBEDDING_DIMENSIONS).fill(Number.NaN)) }), () => ({ data: [] })]) {
      await expect(workersAiEmbedder(fakeAi(shape).ai).embed(["x"])).rejects.toThrow("unexpected embedding shape");
    }
  });

  it("embedMany falls back to one-by-one with a halved budget so one bad text cannot block the rest", async () => {
    const embedder = new FakeEmbedder();
    embedder.fail = (texts) => texts.length > 1 || texts[0] === "poison-full";
    const result = await embedMany(embedder, [
      () => "fine",
      (scale) => (scale === 1 ? "poison-full" : "poison-halved-ok"),
      () => "fine too",
    ]);
    expect(result.map((v) => v !== null)).toEqual([true, true, true]);
    // batch of 3 (fail), then "fine", "poison-full" (fail) + "poison-halved-ok", "fine too"
    expect(embedder.calls.map((texts) => texts.join("|"))).toEqual(["fine|poison-full|fine too", "fine", "poison-full", "poison-halved-ok", "fine too"]);
  });

  it("embedMany returns null for a text that fails at both budgets", async () => {
    const embedder = new FakeEmbedder();
    embedder.fail = (texts) => texts.includes("bad");
    expect(await embedMany(embedder, [() => "bad", () => "ok"])).toEqual([null, expect.any(Array)]);
  });
});

describe("Vectorize adapter", () => {
  function fakeIndex() {
    const log = { upserts: [] as unknown[][], deletes: [] as string[][], queries: [] as Array<{ values: number[]; options: Record<string, unknown> }> };
    const index = {
      async upsert(vectors: unknown[]) {
        log.upserts.push(vectors);
        return { mutationId: "m" };
      },
      async deleteByIds(ids: string[]) {
        log.deletes.push(ids);
        return { mutationId: "m" };
      },
      async query(values: number[], options: Record<string, unknown>) {
        log.queries.push({ values, options });
        return { count: 2, matches: [{ id: "a", score: 0.9, metadata: {} }, { id: "b", score: 0.5 }] };
      },
    } as unknown as Vectorize;
    return { index, log };
  }
  const record = (id: string): VectorRecord => ({
    id,
    namespace: "fintech",
    values: [0.1, 0.2],
    metadata: { tool_name: "transfer_funds", visibility: "public", review_status: "approved", embed_v: EMBED_VERSION },
  });

  it("upserts id, namespace, values and exactly the four metadata fields, in batches of 1,000", async () => {
    const { index, log } = fakeIndex();
    await vectorizeStore(index).upsert(Array.from({ length: MAX_UPSERT_BATCH + 5 }, (_, i) => record(`id-${i}`)));
    expect(log.upserts.map((batch) => batch.length)).toEqual([MAX_UPSERT_BATCH, 5]);
    expect(log.upserts[0]![0]).toEqual({
      id: "id-0",
      namespace: "fintech",
      values: [0.1, 0.2],
      metadata: { tool_name: "transfer_funds", visibility: "public", review_status: "approved", embed_v: EMBED_VERSION },
    });
  });

  it("queries the domain namespace with the filter, topK and exact (high-precision) scoring", async () => {
    const { index, log } = fakeIndex();
    const filter = { tool_name: { $eq: "transfer_funds" }, visibility: { $in: ["public", "k:token"] } };
    const matches = await vectorizeStore(index).query([0.1, 0.2], { namespace: "fintech", topK: 5, filter });
    expect(matches).toEqual([{ id: "a", score: 0.9 }, { id: "b", score: 0.5 }]);
    expect(log.queries[0]!.options).toMatchObject({ namespace: "fintech", topK: 5, filter, returnValues: true, returnMetadata: "indexed" });
    expect(JSON.stringify(filter).length).toBeLessThan(2048);
  });

  it("deletes by id", async () => {
    const { index, log } = fakeIndex();
    await vectorizeStore(index).deleteByIds(["a", "b"]);
    expect(log.deletes).toEqual([["a", "b"]]);
  });
});

describe("secret and PII scan", () => {
  it("flags the shapes it is meant to catch, naming the kind and never the text", () => {
    const hits: Array<[string, string]> = [
      ["contact jane.doe@example.com for approval", "email address"],
      ["postgres://admin:hunter2@db.internal/app", "URL with embedded credentials"],
      ["GB82 WEST 1234 5698 7654 32", "IBAN"],
      ["card 4111 1111 1111 1111 expires soon", "payment card number"],
      ["ssn 123-45-6789", "US social security number"],
      ["NI number AB 12 34 56 C", "UK national insurance number"],
      ["call +44 20 7946 0958 now", "phone number"],
      ["call (415) 555-0132 now", "phone number"],
      ["key AKIAABCDEFGHIJKLMNOP", "AWS access key id"],
    ];
    for (const [text, kind] of hits) expect(findPii(text), text).toBe(kind);
  });

  it("leaves ordinary tool arguments alone", () => {
    for (const text of ["ops-lead", "GBP", "2026-10-09T10:00:00.000Z", "settlement account 12", "1700000000000", "v1.2.3", "BIC-less IBAN GB82 WEST", "order 2024-10-09"]) {
      expect(findPii(text), text).toBeNull();
    }
  });

  it("implements Luhn and IBAN mod-97", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB83WEST12345698765432")).toBe(false);
  });
});

describe("10% audit lottery", () => {
  it("is deterministic per lesson", async () => {
    const id = "6f1c2a52-8c2f-4b8e-9d3a-0e7b1c5d9a11";
    expect(await auditDraw(id)).toEqual(await auditDraw(id));
  });

  it("samples about 10% of lessons", async () => {
    let sampled = 0;
    const total = 5000;
    for (let i = 0; i < total; i++) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      const { value, sampled: hit } = await auditDraw(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      if (hit) sampled += 1;
    }
    expect(AUDIT_SAMPLE_RATE).toBe(0.1);
    expect(sampled / total).toBeGreaterThan(0.085);
    expect(sampled / total).toBeLessThan(0.115);
  });
});
