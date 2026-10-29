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
  createdAt: "2026-10-10T12:34:56.000Z",
};

vi.mock("../../lib/queue", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/queue")>();
  return { ...original, initialQueueState: { ...original.initialQueueState, lessons: [LESSON], loaded: true } };
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
});
