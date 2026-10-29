import { describe, expect, it } from "vitest";
import { domainLabel } from "../ui/src/lib/domains";
import type { FeedLessonView } from "../ui/src/lib/feed";
import { NO_FILTER, domainCounts, filterLessons } from "../ui/src/lib/feedFilter";
import * as lessonText from "../ui/src/lib/lessonText";
import { changedFieldLabels, lessonHeading, lessonIdFromHash, splitSteering } from "../ui/src/lib/lessonText";
import { agentPrompt, siteOrigin } from "../ui/src/lib/site";

const ID = "5e5dc086-bfd7-428e-a694-d328d9e0ffa6";

function lesson(over: Partial<FeedLessonView> = {}): FeedLessonView {
  return {
    lessonId: ID,
    domain: "devsecops",
    tool: "http_request",
    steeringDirective: "Cancel the request. | Use a scoped role.",
    statutoryAnchor: null,
    compliantArguments: { action: "HALT" },
    changedPaths: ["/action", "/approval/status"],
    displayTitle: null,
    displaySummary: null,
    featured: false,
    ...over,
  };
}

describe("lessonHeading", () => {
  it("prefers the editorial title, then the statutory anchor, then a generic line naming the tool", () => {
    expect(lessonHeading({ displayTitle: "Second approver", statutoryAnchor: "FCA SYSC 6.1.1", tool: "dispatch_wire" })).toBe("Second approver");
    expect(lessonHeading({ displayTitle: null, statutoryAnchor: "FCA SYSC 6.1.1", tool: "dispatch_wire" })).toBe("FCA SYSC 6.1.1");
    expect(lessonHeading({ statutoryAnchor: "  FCA SYSC 6.1.1 ", tool: "dispatch_wire" })).toBe("FCA SYSC 6.1.1");
    expect(lessonHeading({ displayTitle: null, statutoryAnchor: null, tool: "dispatch_wire" })).toBe("Policy violation: dispatch_wire");
    expect(lessonHeading({ displayTitle: "  ", statutoryAnchor: "", tool: "dispatch_wire" })).toBe("Policy violation: dispatch_wire");
  });

  it("no longer offers any rule-number parsing", () => {
    expect(lessonText).not.toHaveProperty("splitRule");
  });
});

describe("splitSteering", () => {
  it("takes the first alternative for the row and keeps the rest for the detail", () => {
    expect(splitSteering("Cancel it. | Use a scoped role. | Ask a person.")).toEqual({ lead: "Cancel it.", more: ["Use a scoped role.", "Ask a person."] });
    expect(splitSteering("A single sentence.")).toEqual({ lead: "A single sentence.", more: [] });
  });

  it("copes with no directive and with stray separators", () => {
    expect(splitSteering(null)).toEqual({ lead: null, more: [] });
    expect(splitSteering(" | ")).toEqual({ lead: null, more: [] });
    expect(splitSteering("a|b")).toEqual({ lead: "a|b", more: [] }); // only a spaced pipe separates
  });
});

describe("changedFieldLabels", () => {
  it("shows a few readable names and counts the rest", () => {
    expect(changedFieldLabels(["/action", "/approval/status", "/a", "/b", "/c"])).toEqual({ shown: ["action", "approval.status", "a"], hidden: 2 });
    expect(changedFieldLabels(["/action", "/action"])).toEqual({ shown: ["action"], hidden: 0 });
    expect(changedFieldLabels([])).toEqual({ shown: [], hidden: 0 });
  });
});

describe("lessonIdFromHash", () => {
  it("reads the id from either anchor form, case-insensitively", () => {
    expect(lessonIdFromHash(`#lesson-${ID}`)).toBe(ID);
    expect(lessonIdFromHash(`#lesson-card-${ID}`)).toBe(ID);
    expect(lessonIdFromHash(`#lesson-${ID.toUpperCase()}`)).toBe(ID);
  });

  it("rejects anything else, so a hash can never name an element by accident", () => {
    for (const hash of ["", "#", "#main", "#lesson-", "#lesson-not-an-id", `#lesson-${ID}x`, `lesson-${ID}`, `#lesson-detail-${ID}`]) expect(lessonIdFromHash(hash), hash).toBeNull();
  });
});

describe("filtering the feed", () => {
  const wire = lesson({ lessonId: "11111111-1111-4111-8111-111111111111", domain: "fintech", tool: "dispatch_wire", statutoryAnchor: "Regulation J", changedPaths: ["/dual_control"] });
  const robot = lesson({ lessonId: "22222222-2222-4222-8222-222222222222", domain: "industrial_iot", tool: "dispatch_manipulation", steeringDirective: "Halt motion and reduce speed." });
  const all = [lesson(), wire, robot];

  it("returns everything with no filter", () => {
    expect(filterLessons(all, NO_FILTER)).toEqual(all);
  });

  it("filters by domain", () => {
    expect(filterLessons(all, { domain: "fintech", text: "" })).toEqual([wire]);
    expect(filterLessons(all, { domain: "robotics", text: "" })).toEqual([]);
  });

  it("searches the tool, anchor, directive, domain name and changed fields, ignoring case and padding", () => {
    expect(filterLessons(all, { domain: null, text: "  DISPATCH_WIRE " })).toEqual([wire]);
    expect(filterLessons(all, { domain: null, text: "regulation j" })).toEqual([wire]);
    expect(filterLessons(all, { domain: null, text: "reduce speed" })).toEqual([robot]);
    expect(filterLessons(all, { domain: null, text: "dual_control" })).toEqual([wire]);
    expect(filterLessons(all, { domain: null, text: "industrial iot" })).toEqual([robot]);
    expect(filterLessons(all, { domain: "fintech", text: "owasp" })).toEqual([]);
  });

  it("counts the domains present, known ones first in their usual order", () => {
    expect(domainCounts(all)).toEqual([
      { domain: "fintech", count: 1 },
      { domain: "industrial_iot", count: 1 },
      { domain: "devsecops", count: 1 },
    ]);
    expect(domainCounts([lesson({ domain: "zeta" }), lesson({ domain: "alpha" }), lesson()]).map((entry) => entry.domain)).toEqual(["devsecops", "alpha", "zeta"]);
  });

  it("names a domain it does not know by its slug", () => {
    expect(domainLabel("devsecops")).toBe("DevSecOps");
    expect(domainLabel("zeta")).toBe("zeta");
    expect(domainLabel("toString")).toBe("toString");
  });
});

describe("the prompt a visitor copies", () => {
  it("names this site's own protocol document", () => {
    expect(agentPrompt("https://mom.achromat.ai")).toBe(
      "Read https://mom.achromat.ai/skill.md and follow it to register with Achromat Machine Operational Memory (MOM), then check it before you call a tool.",
    );
  });

  it("uses the page origin when there is one and the production origin otherwise", () => {
    const scope = globalThis as { window?: unknown };
    const before = scope.window;
    try {
      delete scope.window;
      expect(siteOrigin()).toBe("https://mom.achromat.ai");
      scope.window = { location: { origin: "https://preview.example.dev" } };
      expect(siteOrigin()).toBe("https://preview.example.dev");
      scope.window = { location: { origin: "javascript:alert(1)" } };
      expect(siteOrigin()).toBe("https://mom.achromat.ai");
    } finally {
      if (before === undefined) delete scope.window;
      else scope.window = before;
    }
  });
});
