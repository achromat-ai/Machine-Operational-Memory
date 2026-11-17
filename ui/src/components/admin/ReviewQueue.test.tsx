/**
 * The review console keeps its dates: the public pages show none, but an operator managing a queue needs to
 * see when each lesson was created. The queue is rendered to a string with its state seeded through a mock of
 * lib/queue (effects do not run in a static render, so nothing is fetched).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingLesson } from "../../lib/adminApi";
import { createAdminSession } from "../../lib/adminSession";

const LESSON: PendingLesson = {
  lessonId: "11111111-1111-4111-8111-111111111111",
  reviewStatus: "pending_review",
  domain: "fintech",
  tool: "transfer_funds",
  provenance: "community",
  taskDescription: "Move client funds to the settlement account",
  violationRule: "Dual authorisation for large transfers",
  steeringDirective: "Add a second approver.",
  statutoryAnchor: "FCA SYSC 6.1.1",
  trapArguments: { amount: 50000, approval: { second_approver: null } },
  fixArguments: { amount: 50000, approval: { second_approver: "ops-lead" } },
  changedPaths: ["/approval/second_approver"],
  triage: [],
  submitterKey: "a".repeat(64),
  submitterApproved: 0,
  submitterRejected: 0,
  fixedByKey: null,
  corroborations: 0,
  coverage: { sameRuleClass: null, sameDelta: null },
  createdAt: "2026-10-10T12:34:56.000Z",
};
/** Evidence is an invented literal, and a clean-looking lesson already covers its rule class. */
const FLAGGED: PendingLesson = {
  ...LESSON,
  lessonId: "22222222-2222-4222-8222-222222222222",
  tool: "dispatch_wire",
  taskDescription: "Wire 3,000 USD to a vendor",
  trapArguments: { sanctions_evidence: "[UNVERIFIED_STATE]" },
  fixArguments: { sanctions_evidence: "OFAC-DET-2291-CLEARED" },
  changedPaths: ["/sanctions_evidence"],
  triage: [{ check: "burst", passed: false, score: null, details: {} }],
  coverage: { sameRuleClass: "33333333-3333-4333-8333-333333333333", sameDelta: null },
};

vi.mock("../../lib/queue", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/queue")>();
  return { ...original, initialQueueState: { ...original.initialQueueState, lessons: [LESSON, FLAGGED], loaded: true } };
});

const { default: ReviewQueue } = await import("./ReviewQueue");

describe("ReviewQueue", () => {
  const session = createAdminSession({ fetch: async () => new Response("{}", { status: 500 }) });

  it("shows when each lesson was created, in UTC", () => {
    const html = renderToStaticMarkup(<ReviewQueue session={session} agentKeyHex={"b".repeat(64)} />);
    expect(html).toContain("created 2026-10-10 12:34 UTC");
  });

  it("still gives an operator the full rule text and the statutory anchor next to it", () => {
    const html = renderToStaticMarkup(<ReviewQueue session={session} agentKeyHex={"b".repeat(64)} />);
    expect(html).toContain("Dual authorisation for large transfers");
    expect(html).toContain("FCA SYSC 6.1.1");
  });

  it("opens on the cards, with a Digest toggle that is not pressed", () => {
    const html = renderToStaticMarkup(<ReviewQueue session={session} agentKeyHex={"b".repeat(64)} />);
    expect(html).toContain("The trap");
    expect(html).not.toContain("Lessons waiting for a decision");
    expect(html).toMatch(/aria-pressed="false"[^>]*>Digest</);
  });

  describe("digest view", () => {
    const html = () => renderToStaticMarkup(<ReviewQueue session={session} agentKeyHex={"b".repeat(64)} initialView="digest" />);

    it("shows one numbered row per lesson in a single table, and no per-lesson cards", () => {
      const out = html();
      expect(out).toContain("Lessons waiting for a decision");
      expect(out.match(/<tbody[\s\S]*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(2);
      expect(out).not.toContain("The trap");
      expect(out).toContain("2 lessons loaded");
    });

    it("pre-selects Approve for the clean row and Reject for the row with a literal evidence field", () => {
      const out = html();
      const selects = out.match(/<select[\s\S]*?<\/select>/g)!;
      expect(selects).toHaveLength(2);
      // dispatch_wire sorts before transfer_funds, so the flagged lesson is row 1.
      expect(selects[0]).toContain('<option value="reject:incorrect_fix" selected');
      expect(selects[1]).toContain('<option value="approve" selected');
      expect(out).toContain("Ready to send: <strong>1</strong> to approve, <strong>1</strong> to reject, 0 left in the queue.");
    });

    it("shows the checks, coverage and flags that explain each proposal, as plain text", () => {
      const out = html();
      expect(out).toContain("NEW");
      expect(out).toContain("covered by");
      expect(out).toContain("33333333");
      expect(out).toContain("evidence field /sanctions_evidence holds a literal");
      expect(out).toContain("triage burst failed");
      expect(out).toContain("/sanctions_evidence");
      expect(out).toContain("[UNVERIFIED_STATE] → OFAC-DET-2291-CLEARED");
    });

    it("sends nothing until the summary is confirmed: the first button only opens the confirmation", () => {
      const out = html();
      expect(out).toContain("Review and send 2 decisions");
      expect(out).not.toContain("Confirm and send");
    });

    it("leaves the operator's own lesson out of the decisions", () => {
      const mine = renderToStaticMarkup(<ReviewQueue session={session} agentKeyHex={"a".repeat(64)} initialView="digest" />);
      expect(mine).toContain("Your own lesson");
      expect(mine).toContain("Ready to send: <strong>0</strong> to approve, <strong>0</strong> to reject, 2 left in the queue.");
    });
  });
});
