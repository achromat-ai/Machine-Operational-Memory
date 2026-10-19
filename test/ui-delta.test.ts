/**
 * The Delta View's data (ui/src/lib/delta.ts): pointer handling, field-by-field rows and highlighting.
 * Cross-checked against the server's own diff (src/pairing.ts), which produces the changed_paths the page
 * receives, so the highlighted fields can never drift from what the lesson actually changed.
 */
import { describe, expect, it } from "vitest";
import { buildPairDelta } from "../src/pairing";
import {
  buildDeltaRows,
  describeRow,
  flattenLeaves,
  formatValue,
  parsePointer,
  pathLabel,
  pointerFromTokens,
  splitRows,
  valuesEqual,
} from "../ui/src/lib/delta";

const TRAP = { amount: 50000, currency: "GBP", approval: { second_approver: null } };
const FIX = { amount: 50000, currency: "GBP", approval: { second_approver: "ops-lead" } };

describe("JSON pointers", () => {
  it("parses RFC 6901 pointers, including escapes", () => {
    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("/a")).toEqual(["a"]);
    expect(parsePointer("/approval/second_approver")).toEqual(["approval", "second_approver"]);
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(parsePointer("/")).toEqual([""]);
    expect(parsePointer("/a~01")).toEqual(["a~1"]); // ~0 first, then the literal 1
  });

  it("rejects text that is not a pointer", () => {
    for (const bad of ["a", "approval/second_approver", "/a~2", "/a~", "~0"]) expect(parsePointer(bad), bad).toBeNull();
  });

  it("round-trips through pointerFromTokens", () => {
    for (const tokens of [[], ["a"], ["a/b", "c~d"], ["", "x"], ["~", "/"]]) expect(parsePointer(pointerFromTokens(tokens))).toEqual(tokens);
  });

  it("labels fields for people", () => {
    expect(pathLabel("/approval/second_approver")).toBe("approval.second_approver");
    expect(pathLabel("")).toBe("(whole call)");
    expect(pathLabel("not a pointer")).toBe("not a pointer");
  });
});

describe("flattenLeaves", () => {
  it("walks objects and treats arrays, scalars, null and empty objects as whole values", () => {
    const leaves = flattenLeaves({ a: { b: 1, c: [1, { d: 2 }] }, e: null, f: {}, "g/h": "x" });
    expect(Object.fromEntries(leaves)).toEqual({ "/a/b": 1, "/a/c": [1, { d: 2 }], "/e": null, "/g~1h": "x" });
  });

  it("stops after 20,000 nodes instead of hanging on a huge value", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;
    expect(flattenLeaves(wide).size).toBeLessThanOrEqual(20_000);
  });
});

describe("valuesEqual", () => {
  it("ignores key order, not value differences", () => {
    expect(valuesEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    expect(valuesEqual("5", 5)).toBe(false);
    expect(valuesEqual(null, undefined)).toBe(false);
  });
});

describe("buildDeltaRows", () => {
  it("compares the trap with the fix and highlights exactly the changed field", () => {
    const rows = buildDeltaRows(TRAP, FIX, ["/approval/second_approver"]);
    expect(rows.map((r) => [r.path, r.status, r.highlighted])).toEqual([
      ["/amount", "same", false],
      ["/approval/second_approver", "changed", true],
      ["/currency", "same", false],
    ]);
    const { visible, unchanged } = splitRows(rows);
    expect(visible.map((r) => r.path)).toEqual(["/approval/second_approver"]);
    expect(unchanged.map((r) => r.path)).toEqual(["/amount", "/currency"]);
    expect(visible[0]).toMatchObject({ left: null, right: "ops-lead", hasLeft: true, hasRight: true, label: "approval.second_approver" });
  });

  it("reports a field the fix adds, and one it removes", () => {
    const added = buildDeltaRows({ amount: 1 }, { amount: 1, approval: { second_approver: "x" } }, ["/approval/second_approver"]);
    expect(added.find((r) => r.path === "/approval/second_approver")).toMatchObject({ status: "added", hasLeft: false, hasRight: true, highlighted: true });

    const removed = buildDeltaRows({ amount: 1, memo: "note" }, { amount: 1 }, ["/memo"]);
    expect(removed.find((r) => r.path === "/memo")).toMatchObject({ status: "removed", hasLeft: true, hasRight: false, highlighted: true });
  });

  it("on the public page, flags a changed field the user's call already satisfies", () => {
    const rows = buildDeltaRows({ ...FIX }, FIX, ["/approval/second_approver"]);
    expect(rows.find((r) => r.path === "/approval/second_approver")).toMatchObject({ status: "same", highlighted: true });
    expect(describeRow(rows.find((r) => r.highlighted)!, "left")).toBe("already matches");
  });

  it("highlights both sides when a value changes shape, because the pointer covers the whole value", () => {
    const rows = buildDeltaRows({ a: { b: 1, c: 2 } }, { a: 5 }, ["/a"]);
    expect(rows.map((r) => [r.path, r.status, r.highlighted])).toEqual([
      ["/a", "added", true],
      ["/a/b", "removed", true],
      ["/a/c", "removed", true],
    ]);
  });

  it("with nothing to compare, keeps every row 'same' and only highlights the changed fields", () => {
    const rows = buildDeltaRows(null, FIX, ["/approval/second_approver"]);
    expect(rows.every((r) => r.status === "same")).toBe(true);
    expect(rows.filter((r) => r.highlighted).map((r) => r.path)).toEqual(["/approval/second_approver"]);
    expect(describeRow(rows.find((r) => r.highlighted)!, "right", false)).toBe("set by the fix");
    expect(describeRow(rows.find((r) => !r.highlighted)!, "right", false)).toBe("unchanged");
  });

  it("ignores pointers that are not valid, and highlights everything for the whole-document pointer", () => {
    expect(buildDeltaRows(TRAP, FIX, ["nonsense", "/approval/~2"]).some((r) => r.highlighted)).toBe(false);
    expect(buildDeltaRows(TRAP, FIX, [""]).every((r) => r.highlighted)).toBe(true);
  });

  it("treats arrays as single values", () => {
    const rows = buildDeltaRows({ tags: ["a", "b"] }, { tags: ["a", "c"] }, ["/tags"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "/tags", status: "changed", highlighted: true });
  });

  it("is stable: the same input always gives the same ordered rows", () => {
    const again = buildDeltaRows({ b: 1, a: 2 }, { a: 2, b: 3 }, ["/b"]);
    expect(again.map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("matches the server's diff: the highlighted fields are exactly the lesson's changed_paths", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [TRAP, FIX],
      [{ a: 1, b: { c: 1, d: 2 } }, { a: 1, b: { c: 9, d: 2 } }],
      [{ a: 1 }, { a: 1, extra: { deep: { deeper: true } } }],
      [{ a: 1, gone: { x: 1 } }, { a: 1 }],
      [{ list: [1, 2, 3], keep: "x" }, { list: [1, 2], keep: "x" }],
      [{ a: { b: 1 } }, { a: 7 }],
      [{ "we/ird": { "k~ey": 1 } }, { "we/ird": { "k~ey": 2 } }],
      [{ n: null, e: {} }, { n: 0, e: { filled: 1 } }],
      [{ f: 5, keep: 1 }, { f: {}, keep: 1 }],
      [{ f: {}, keep: 1 }, { f: 5, keep: 1 }],
      [{ f: { x: 1 }, keep: 1 }, { f: {}, keep: 1 }],
    ];
    for (const [trap, fix] of cases) {
      const delta = (await buildPairDelta(trap, fix))!;
      const rows = buildDeltaRows(trap, fix, delta.changedPaths);
      const highlighted = rows.filter((r) => r.highlighted).map((r) => r.path);
      // Every pointer the server reports is covered by a highlighted row, and nothing else is highlighted.
      for (const pointer of delta.changedPaths) {
        expect(highlighted.some((path) => path === pointer || path.startsWith(`${pointer}/`)), `${JSON.stringify(trap)} -> ${pointer}`).toBe(true);
      }
      for (const path of highlighted) {
        expect(delta.changedPaths.some((pointer) => path === pointer || path.startsWith(`${pointer}/`)), path).toBe(true);
      }
      // And the rows that differ are all highlighted.
      expect(rows.filter((r) => r.status !== "same").every((r) => r.highlighted)).toBe(true);
    }
  });
});

describe("describeRow", () => {
  const rows = buildDeltaRows({ a: 1, b: 1, gone: 1 }, { a: 2, b: 1, fresh: 1 }, ["/a", "/gone", "/fresh"]);
  const row = (path: string) => rows.find((r) => r.path === path)!;

  it("words each side so it never depends on colour", () => {
    expect(describeRow(row("/a"), "left")).toBe("needs to change");
    expect(describeRow(row("/a"), "right")).toBe("changed");
    expect(describeRow(row("/gone"), "left")).toBe("to be removed");
    expect(describeRow(row("/gone"), "right")).toBe("removed by the fix");
    expect(describeRow(row("/fresh"), "left")).toBe("not set");
    expect(describeRow(row("/fresh"), "right")).toBe("added");
    expect(describeRow(row("/b"), "left")).toBe("unchanged");
    expect(describeRow(row("/b"), "right")).toBe("unchanged");
  });
});

describe("formatValue", () => {
  it("keeps strings quoted so '5' and 5 differ", () => {
    expect(formatValue("5").preview).toBe('"5"');
    expect(formatValue(5).preview).toBe("5");
    expect(formatValue(null).preview).toBe("null");
    expect(formatValue(undefined).preview).toBe("undefined");
    expect(formatValue({ a: [1, 2] }).preview).toBe('{"a":[1,2]}');
    expect(formatValue("short").truncated).toBe(false);
  });

  it("truncates long values to one line and offers the full text, capped", () => {
    const long = formatValue("x".repeat(500));
    expect(long.truncated).toBe(true);
    expect(long.preview.length).toBeLessThanOrEqual(160);
    expect(long.preview.endsWith("…")).toBe(true);
    expect(long.full.length).toBeGreaterThan(160);

    const huge = formatValue({ data: "y".repeat(10_000) });
    expect(huge.full.length).toBeLessThanOrEqual(4000);
  });

  it("never throws, whatever it is given", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatValue(circular)).not.toThrow();
    expect(() => formatValue(10n)).not.toThrow();
    expect(() => formatValue(Symbol("s"))).not.toThrow();
  });
});
