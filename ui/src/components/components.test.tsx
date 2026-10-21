/**
 * Server-side render checks for the presentational components. They render to a string with
 * react-dom/server, so there is no DOM and no browser: what is asserted is the markup a visitor receives
 * (labels, highlighting, wording, escaping), not interaction. Interaction logic lives in lib/ and is
 * tested there against the real Worker.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../App";
import ReviewActions from "./admin/ReviewActions";
import AdminAuth from "./admin/AdminAuth";
import DeltaCard from "./public/DeltaCard";
import ResultList from "./public/ResultList";
import CopyButton from "./public/CopyButton";
import FeedList from "./public/FeedList";
import Hero from "./public/Hero";
import PublicPage from "./public/PublicPage";
import SearchInput from "./public/SearchInput";
import SimpleSearch from "./public/SimpleSearch";
import SiteFooter from "./public/SiteFooter";
import { createAdminSession } from "../lib/adminSession";
import { initialFeedState, type FeedLessonView, type FeedState } from "../lib/feed";
import { initialRecallState, type RecallEntry, type RecallState } from "../lib/recall";
import { initialSearchState, type SearchState } from "../lib/search";

const TRAP = { amount: 50000, currency: "GBP", approval: { second_approver: null } };
const FIX = { amount: 50000, currency: "GBP", approval: { second_approver: "ops-lead" } };

function card(overrides: Partial<Parameters<typeof DeltaCard>[0]> = {}) {
  return renderToStaticMarkup(
    <DeltaCard
      heading="Dual authorisation for large transfers"
      steeringDirective="Add a second approver before moving the funds."
      statutoryAnchor="FCA SYSC 6.1.1"
      left={TRAP}
      right={FIX}
      changedPaths={["/approval/second_approver"]}
      {...overrides}
    />,
  );
}

describe("DeltaCard", () => {
  it("shows the rule, the steering directive and the statutory anchor prominently", () => {
    const html = card();
    expect(html).toContain("Dual authorisation for large transfers");
    expect(html).toContain('aria-label="Steering directive"');
    expect(html).toContain("Add a second approver before moving the funds.");
    expect(html).toContain("Statutory anchor: ");
    expect(html).toContain("FCA SYSC 6.1.1");
    // The directive comes before the panels.
    expect(html.indexOf("Steering directive")).toBeLessThan(html.indexOf("Your call"));
  });

  it("splits into the call and the fix, side by side from md and stacked below it", () => {
    const html = card();
    expect(html).toContain('data-side="left"');
    expect(html).toContain('data-side="right"');
    expect(html).toContain("Your call");
    expect(html).toContain("The fix");
    expect(html).toMatch(/grid grid-cols-1 gap-4 p-5 md:grid-cols-2/);
  });

  it("highlights exactly the field the lesson changed, on both sides, with words as well as colour", () => {
    const html = card();
    const highlighted = [...html.matchAll(/data-path="([^"]+)" data-highlighted="(true|false)"/g)].filter((m) => m[2] === "true").map((m) => m[1]);
    expect(highlighted).toEqual(["/approval/second_approver", "/approval/second_approver"]); // once per panel
    expect(html).toContain("border-compliant bg-compliant/10"); // the fix side
    expect(html).toContain("border-blocked bg-blocked/10"); // the call side
    expect(html).toContain("+ changed");
    expect(html).toContain("− needs to change");
    expect(html).toContain("approval.second_approver");
    expect(html).toContain("&quot;ops-lead&quot;");
  });

  it("keeps unchanged fields out of the way, in a collapsed section", () => {
    const html = card();
    expect(html).toContain("2 unchanged fields");
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>2 unchanged fields<\/summary>/);
    const panels = html.slice(html.indexOf('data-testid="delta-panels"'), html.indexOf("<details"));
    expect(panels).not.toContain("/currency");
  });

  it("with no call to compare, draws only the fix and still highlights the changed field", () => {
    const html = card({ left: null });
    expect(html).not.toContain('data-side="left"');
    expect(html).toContain('data-side="right"');
    expect(html).toContain("set by the fix");
  });

  it("uses the labels it is given (the console compares the trap with the fix)", () => {
    const html = card({ leftLabel: "The trap", rightLabel: "The fix" });
    expect(html).toContain("The trap");
    expect(html).not.toContain("Your call");
  });

  it("marks a field the fix adds and one it removes", () => {
    const html = card({ left: { amount: 1, memo: "note" }, right: { amount: 1, approval: { second_approver: "x" } }, changedPaths: ["/memo", "/approval/second_approver"] });
    expect(html).toContain("+ added");
    expect(html).toContain("− to be removed");
    expect(html).toContain("removed by the fix");
    expect(html).toContain("not set in your call");
  });

  it("omits what it has no data for", () => {
    const html = card({ steeringDirective: null, statutoryAnchor: null });
    expect(html).not.toContain("Steering directive");
    expect(html).not.toContain("Statutory anchor");
  });

  it("renders untrusted text as text: markup in a value or a directive is escaped", () => {
    const html = card({
      heading: "<img src=x onerror=alert(1)>",
      steeringDirective: "<script>alert('x')</script>",
      left: { note: "<b onmouseover=alert(1)>hi</b>" },
      right: { note: "\"><svg onload=alert(1)>" },
      changedPaths: ["/note"],
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("collapses a very long value behind a details element with the full text inside", () => {
    const long = "x".repeat(600);
    const html = card({ left: { blob: "short" }, right: { blob: long }, changedPaths: ["/blob"] });
    expect(html).toMatch(/<details class="text-sm">/);
    expect(html).toContain(`${"x".repeat(100)}`);
    expect(html.match(/x{500,}/)).not.toBeNull(); // the full text is in the markup, inside <pre>
  });

  it("uses no inline styles and no script, so it fits the page's content security policy", () => {
    const html = card({ children: <p>extra</p>, footer: <button type="button">go</button>, meta: <span>meta</span>, note: "small print" });
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script|<style|\son[a-z]+=/i);
    expect(html).toContain("small print");
    expect(html).toContain("<footer");
  });

  it("is labelled for assistive technology: an article named by its heading, and named panels", () => {
    const html = card();
    expect(html).toMatch(/<article aria-labelledby="([^"]+)"/);
    const id = html.match(/<article aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`id="${id}"`);
    expect([...html.matchAll(/<section aria-labelledby=/g)]).toHaveLength(2);
  });
});

describe("SimpleSearch", () => {
  const render = (state: Partial<SearchState> = {}) => renderToStaticMarkup(<SimpleSearch onSearch={() => undefined} state={{ ...initialSearchState, ...state }} />);

  it("is one question box and a domain, each with a label, and none of the technical fields", () => {
    const html = render();
    for (const label of ["Domain", "What is your agent about to do?"]) expect(html).toContain(label);
    expect([...html.matchAll(/<label for="([^"]+)"/g)]).toHaveLength(2);
    for (const [, id] of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('type="search"');
    expect(html).not.toContain("Tool name");
    expect(html).not.toContain("JSON");
    expect([...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual(["fintech", "industrial_iot", "robotics", "devsecops"]);
  });

  it("says it is searching and disables the button while a search runs", () => {
    const html = render({ phase: "loading" });
    expect(html).toContain("Searching…");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(render()).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("shows service errors, an empty answer and a found lesson without the blocked call's values", () => {
    expect(render({ phase: "error", error: { message: "Search is temporarily unavailable. Try again shortly.", fieldErrors: { query: "q must be at least 3 characters" } } })).toContain(
      "q must be at least 3 characters",
    );
    const query = { domain: "fintech", q: "send a wire" } as const;
    expect(render({ query, results: [] })).toContain("No lesson found");
    const lesson = {
      lessonId: "5e5dc086-bfd7-428e-a694-d328d9e0ffa6",
      domain: "fintech",
      tool: "dispatch_wire",
      violationRule: "Dual authorisation for large transfers",
      steeringDirective: "Add a second approver.",
      statutoryAnchor: null,
      compliantArguments: { approval: { second_approver: "ops-lead" } },
      changedPaths: ["/approval/second_approver"],
      displayTitle: null,
      displaySummary: null,
      featured: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const html = render({ query, results: [{ score: 0.71, lesson }] });
    expect(html).toContain("Dual authorisation for large transfers");
    expect(html).toContain("Similarity 0.71");
    expect(html).toContain("dispatch_wire");
    expect(html).toContain("second_approver");
    expect(html).not.toContain("Your call");
  });
});

describe("SearchInput", () => {
  const render = (props: Partial<Parameters<typeof SearchInput>[0]> = {}) => renderToStaticMarkup(<SearchInput onSearch={() => undefined} busy={false} {...props} />);

  it("asks for the domain, the tool, the task and the arguments, each with a label", () => {
    const html = render();
    for (const label of ["Domain", "Tool name", "What are you trying to do?", "Arguments of the call (JSON)"]) expect(html).toContain(label);
    expect([...html.matchAll(/<label for="([^"]+)"/g)]).toHaveLength(4);
    for (const [, id] of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
  });

  it("offers exactly the four domains", () => {
    const html = render();
    expect([...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual(["fintech", "industrial_iot", "robotics", "devsecops"]);
  });

  it("does not let the browser autofill or autocorrect technical input", () => {
    const html = render();
    // Attribute names are case-insensitive in HTML; React prints them in camelCase.
    expect((html.match(/autocomplete="off"/gi) ?? []).length).toBe(2);
    expect((html.match(/spellcheck="false"/gi) ?? []).length).toBe(2);
    expect((html.match(/autocapitalize="off"/gi) ?? []).length).toBe(2);
  });

  it("while a search runs, disables the button and says so", () => {
    const html = render({ busy: true });
    expect(html).toContain("Searching…");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(render()).toContain("Search lessons");
  });

  it("shows field errors from the service next to the fields they belong to", () => {
    const html = render({ serverErrors: { tool: "tool must be at most 64 characters", arguments: "arguments must be a JSON object" } });
    expect(html).toContain("tool must be at most 64 characters");
    expect(html).toContain("arguments must be a JSON object");
    expect(html).toContain('aria-invalid="true"');
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
  });

  it("explains how the description and the arguments are matched", () => {
    const html = render();
    expect(html).toContain("Only the key names are used to find similar lessons");
    expect(html).toContain("similar wording finds similar lessons");
  });
});

describe("ResultList", () => {
  const query = { domain: "fintech" as const, tool: "transfer_funds", task_description: "Move client funds to the settlement account", arguments: TRAP };
  const withEntries = (entries: RecallEntry[], over: Partial<RecallState> = {}): RecallState => ({ ...initialRecallState, entries, ...over });
  const match: RecallEntry = {
    id: 1,
    query,
    outcome: {
      kind: "match",
      tier: "semantic",
      score: 0.9123,
      lesson: {
        lessonId: "id",
        reviewStatus: "pending",
        domain: "fintech",
        tool: "transfer_funds",
        violationRule: "Dual authorisation for large transfers",
        steeringDirective: "Add a second approver.",
        statutoryAnchor: null,
        compliantArguments: FIX,
        changedPaths: ["/approval/second_approver"],
      },
    },
  };

  it("announces results politely and starts with a hint", () => {
    const html = renderToStaticMarkup(<ResultList state={initialRecallState} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Results appear here");
  });

  it("shows a loading state that reduced-motion users do not see animate", () => {
    const html = renderToStaticMarkup(<ResultList state={{ ...initialRecallState, phase: "loading" }} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("first search sets up a secure session");
  });

  it("shows a failure as an alert in plain words", () => {
    const html = renderToStaticMarkup(<ResultList state={{ ...initialRecallState, phase: "error", error: { message: "Search is temporarily unavailable. Try again shortly." } }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Search is temporarily unavailable. Try again shortly.");
  });

  it("renders a match as a Delta card with your call against the fix, and says where the call came from", () => {
    const html = renderToStaticMarkup(<ResultList state={withEntries([match])} />);
    expect(html).toContain("Dual authorisation for large transfers");
    expect(html).toContain("Similar task (score 0.91)");
    expect(html).toContain("Your own lesson, awaiting review");
    expect(html).toContain("Your call");
    expect(html).toContain("The values of the call that was originally blocked are never shown.");
    expect(html).toContain("+ changed");
  });

  it("renders an exact, reviewed match", () => {
    const exact: RecallEntry = { ...match, outcome: { ...(match.outcome as Extract<RecallEntry["outcome"], { kind: "match" }>), tier: "exact", score: 1, lesson: { ...(match.outcome as Extract<RecallEntry["outcome"], { kind: "match" }>).lesson, reviewStatus: "approved" } } };
    const html = renderToStaticMarkup(<ResultList state={withEntries([exact])} />);
    expect(html).toContain("Exact match");
    expect(html).toContain(">Reviewed<");
  });

  it("renders misses, including an exhausted allowance", () => {
    const miss = renderToStaticMarkup(<ResultList state={withEntries([{ id: 1, query, outcome: { kind: "miss", budgetExhausted: false } }])} />);
    expect(miss).toContain("No lesson found");
    expect(miss).toContain("has not been blocked and fixed before");
    const spent = renderToStaticMarkup(<ResultList state={withEntries([{ id: 2, query, outcome: { kind: "miss", budgetExhausted: true } }])} />);
    expect(spent).toContain("allowance of lessons");
  });

  it("lists the newest result first and keeps earlier ones", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={withEntries([
          { id: 2, query: { ...query, tool: "newest_tool" }, outcome: { kind: "miss", budgetExhausted: false } },
          { id: 1, query: { ...query, tool: "oldest_tool" }, outcome: { kind: "miss", budgetExhausted: false } },
        ])}
      />,
    );
    expect(html.indexOf("newest_tool")).toBeLessThan(html.indexOf("oldest_tool"));
  });
});

describe("FeedList", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const lesson: FeedLessonView = {
    lessonId: ID,
    domain: "fintech",
    tool: "transfer_funds",
    violationRule: "Dual authorisation for large transfers",
    steeringDirective: "Add a second approver.",
    statutoryAnchor: "FCA SYSC 6.1.1",
    compliantArguments: FIX,
    changedPaths: ["/approval/second_approver"],
    displayTitle: null,
    displaySummary: null,
    featured: false,
    updatedAt: "2026-10-10T12:00:00.000Z",
  };
  const ready = (lessons: FeedLessonView[], over: Partial<FeedState> = {}): FeedState => ({ ...initialFeedState, phase: "ready", lessons, ...over });
  /** Renders with a stubbed `window` so the page can be opened on a `#lesson-<id>` link, as a visitor's browser would. */
  function render(state: FeedState, hash = ""): string {
    const scope = globalThis as { window?: unknown };
    const before = scope.window;
    scope.window = { location: { pathname: "/", hash } };
    try {
      return renderToStaticMarkup(<FeedList state={state} onRefresh={() => {}} />);
    } finally {
      if (before === undefined) delete scope.window;
      else scope.window = before;
    }
  }

  it("shows a table-shaped loading state that reduced-motion users do not see animate", () => {
    const html = render(initialFeedState);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("Loading the latest lessons");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Filter by domain");
  });

  it("shows a first-load failure as an alert with a way to retry", () => {
    const html = render({ ...initialFeedState, phase: "error", error: "The feed is temporarily unavailable. Try again shortly." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The feed is temporarily unavailable. Try again shortly.");
    expect(html).toContain("Try again");
  });

  it("explains an empty feed", () => {
    expect(render(ready([]))).toContain("No approved lessons yet");
  });

  it("lays lessons out as a table: Domain, Tool, Violation and Fix, with the details closed", () => {
    const html = render(ready([lesson]));
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table).toContain('aria-labelledby="feed-heading"');
    for (const heading of ["Domain", "Tool", "Violation", "Fix"]) expect(table).toMatch(new RegExp(`<th scope="col"[^>]*>${heading}</th>`));
    expect(table).toContain("Fintech and banking");
    expect(table).toContain("transfer_funds");
    expect(table).toContain("Dual authorisation for large transfers");
    expect(table).toContain("Add a second approver.");
    expect(table).toContain(">approval.second_approver<"); // the changed field, named in the row itself
    expect(table).toContain(`id="lesson-${ID}"`);
    expect(table).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="lesson-detail-1111/);
    expect(table).toContain('aria-label="Show details for transfer_funds"');
    expect(table).toContain(`<tr id="lesson-detail-${ID}" hidden=""></tr>`);
    // Nothing from the detail view is on the page until a row is opened.
    for (const detail of ["The fix", "Statutory anchor", "FCA SYSC 6.1.1", "Copy blueprint JSON", "set by the fix"]) expect(html, detail).not.toContain(detail);
  });

  it("draws the same lessons as cards below the md breakpoint, and the table only from it", () => {
    const html = render(ready([lesson]));
    expect(html).toContain('class="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block"');
    expect(html).toMatch(/<ul aria-labelledby="feed-heading" class="space-y-3 md:hidden"/);
    expect(html).toContain(`id="lesson-card-${ID}"`);
    expect(html).toContain('aria-controls="lesson-card-detail-1111');
    expect(html).toContain("Show details");
    // The two forms never share an id.
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("splits a long rule into the statute and a rule chip", () => {
    const html = render(ready([{ ...lesson, violationRule: "ISO 10218-1:2025 and ISO 10218-2:2025 — industrial robot safety requirements: Rule 4" }]));
    expect(html).toContain("ISO 10218-1:2025 and ISO 10218-2:2025 — industrial robot safety requirements");
    expect(html).toContain(">Rule 4<");
    expect(html).toContain('aria-label="Show details for transfer_funds, Rule 4"');
  });

  it("opens the lesson a #lesson-<id> link names, with the exact fix, no blocked values, and the extra directive text", () => {
    const html = render(ready([{ ...lesson, steeringDirective: "Add a second approver. | Obtain an approved ticket first." }]), `#lesson-${ID}`);
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).toContain("The fix");
    expect(html).not.toContain("Your call");
    expect(html).toContain('data-path="/approval/second_approver"');
    expect(html).toContain("set by the fix");
    expect(html).toContain("Obtain an approved ticket first.");
    expect(html).toContain("FCA SYSC 6.1.1");
    expect(html).toContain("The values of the call that was originally blocked are not published.");
    expect(html).toContain("Copy blueprint JSON");
    expect(html).toContain('dateTime="2026-10-10T12:00:00.000Z"'); // React's spelling of the attribute
    expect(html).toContain("unchanged fields");
    expect(html).toContain("Hide details");
  });

  it("ignores a link to a lesson that is not in the feed", () => {
    expect(render(ready([lesson]), "#lesson-99999999-9999-4999-8999-999999999999")).not.toContain('aria-expanded="true"');
    expect(render(ready([lesson]), "#not-a-lesson")).not.toContain('aria-expanded="true"');
  });

  it("uses the editorial title in the row, keeps the summary for the detail, and marks featured lessons", () => {
    const edited = { ...lesson, displayTitle: "Second approver on big transfers", displaySummary: "Large transfers need two people.", featured: true };
    const closed = render(ready([edited]));
    expect(closed).toContain("Second approver on big transfers");
    expect(closed).toContain(">Featured<");
    expect(closed).not.toContain("Large transfers need two people.");
    expect(render(ready([edited]), `#lesson-${ID}`)).toContain("Large transfers need two people.");
  });

  it("offers a domain filter with counts and a labelled text filter, and announces only a short count", () => {
    const other = { ...lesson, lessonId: "22222222-2222-4222-8222-222222222222", domain: "devsecops", tool: "http_request" };
    const html = render(ready([lesson, other]));
    expect(html).toContain('role="group" aria-label="Filter by domain"');
    expect(html).toContain("All (2)");
    expect(html).toContain("Fintech and banking (1)");
    expect(html).toContain("DevSecOps (1)");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>All \(2\)/);
    expect(html).toMatch(/<label[^>]*>Filter these lessons<\/label>/);
    expect(html).toContain('type="search"');
    expect(html).toContain("Showing 2 of 2 lessons.");
    // The live region is the count line, not the list.
    expect(html).not.toMatch(/<section[^>]*aria-live/);
    expect(html).toMatch(/<p aria-live="polite" class="sr-only">Showing 2 of 2 lessons\.<\/p>/);
  });

  it("keeps the old lessons on screen and says so when a refresh fails", () => {
    const html = render(ready([lesson], { stale: true, error: "The feed could not be reached. Check your connection and try again." }));
    expect(html).toContain("may be out of date");
    expect(html).toContain("Dual authorisation for large transfers");
    expect(html).not.toContain('role="alert"');
  });
});

describe("Hero and site chrome", () => {
  it("leads with the promise, the protocol link in a new tab and a copy button", () => {
    const html = renderToStaticMarkup(<Hero />);
    expect(html).toContain("Agents forget.");
    expect(html).toContain("MOM remembers.");
    expect(html).toMatch(/<h1 id="hero-heading"/);
    expect(html).toMatch(/<a href="\/skill\.md" target="_blank" rel="noopener noreferrer"[^>]*>Read skill\.md/);
    expect(html).toContain("(opens in a new tab)");
    expect(html).toContain("Copy agent prompt");
    expect(html).toContain("Example lesson");
    for (const domain of ["Fintech and banking", "Industrial IoT", "DevSecOps"]) expect(html).toContain(domain);
    expect(html).not.toContain("Robotics");
  });

  it("copies nothing and shows no fallback field until the button is pressed", () => {
    const html = renderToStaticMarkup(<CopyButton text="secret-free text" label="Copy it" />);
    expect(html).toContain("Copy it");
    expect(html).not.toContain("Copy this text yourself");
    expect(html).toContain('role="status"');
  });

  it("has a footer with the protocol link in a new tab and no link off the site", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toMatch(/<a href="\/skill\.md" target="_blank" rel="noopener noreferrer"/);
    expect(html).not.toMatch(/github/i);
    expect(html).not.toMatch(/href="https?:/);
  });
});

describe("ReviewActions", () => {
  const noop = async () => null;
  const render = (props: Partial<Parameters<typeof ReviewActions>[0]> = {}) =>
    renderToStaticMarkup(<ReviewActions lessonId="11111111-1111-4111-8111-111111111111" quarantined={false} ownLesson={false} onDecide={noop} {...props} />);

  it("offers Approve and Reject, both enabled", () => {
    const html = render();
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("disables both and explains why when the reviewer submitted or fixed the lesson", () => {
    const html = render({ ownLesson: true });
    expect(html.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(2);
    expect(html).toContain("You submitted or fixed this lesson, so a different reviewer has to decide it.");
  });

  it("does not show the reject form until Reject is chosen", () => {
    const html = render();
    expect(html).not.toContain("Reason");
    expect(html).not.toContain("<select");
  });
});

describe("AdminAuth", () => {
  const session = createAdminSession({ fetch: async () => new Response("{}", { status: 500 }) });
  const html = renderToStaticMarkup(<AdminAuth session={session} />);

  it("takes the key in an empty, uncontrolled field that the browser will not remember or correct", () => {
    expect(html).toMatch(/<textarea[^>]*name="key"/);
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/); // no value rendered into the markup
    const lower = html.toLowerCase();
    for (const attribute of ['autocomplete="off"', 'spellcheck="false"', 'autocapitalize="off"', 'autocorrect="off"']) expect(lower).toContain(attribute);
  });

  it("states that the key stays in the tab and is cleared on submit", () => {
    expect(html).toContain("never saved");
    expect(html).toContain("cleared from this box as soon as you submit");
  });

  it("also takes a key file, restricted to key-like types", () => {
    expect(html).toContain('type="file"');
    expect(html).toContain("Choose a key file instead");
  });
});

describe("public page and routing", () => {
  function renderAt(pathname: string): string {
    const scope = globalThis as { window?: unknown };
    const before = scope.window;
    scope.window = { location: { pathname } };
    try {
      return renderToStaticMarkup(<App />);
    } finally {
      if (before === undefined) delete scope.window;
      else scope.window = before;
    }
  }

  it("serves the plain-language search and the live feed at /, with the structured lookup folded away between them", () => {
    const html = renderAt("/");
    expect(html).toContain('href="#main"');
    expect(html).toContain("Skip to content");
    expect(html).toContain("<header");
    expect(html).toMatch(/<main id="main"/);
    expect(html).toContain("Latest approved lessons");
    expect(html).toContain("Loading the latest lessons");
    // The default view is the simple search, open and visible.
    expect(html).toContain('aria-label="Search lessons"');
    expect(html).toContain("What is your agent about to do?");
    expect(html.indexOf('aria-label="Search lessons"')).toBeLessThan(html.indexOf("Advanced Agent Simulator"));
    // The JSON form is mounted (so typed text survives a collapse) but hidden behind a labelled toggle.
    expect(html).toContain('aria-label="Simulate a recall"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?Advanced Agent Simulator/);
    expect(html).toMatch(/<div id="[^"]+" hidden="" class="[^"]*">\s*<p[^>]*>Look up a call you are about to make/);
    expect(html.indexOf("Advanced Agent Simulator")).toBeLessThan(html.indexOf("Latest approved lessons"));
    expect(html).not.toContain("Advanced Agent Search");
  });

  it("puts the mark, the wordmark and the agent protocol link (in a new tab) in the global header", () => {
    for (const html of [renderAt("/"), renderAt("/nope")]) {
      const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
      // One home link: both images are decoration, and one always-present text names the link (the wordmark is hidden on small screens).
      expect(header).toMatch(/<a href="\/"[^>]*>\s*<img src="\/logo-light\.png" width="190" height="160" alt=""/);
      expect(header).toMatch(/<img src="\/logo-text\.png" width="640" height="75" alt=""/);
      expect(header).toContain('<span class="sr-only">Achromat Machine Operational Memory: home</span>');
      expect(header).toMatch(/<nav aria-label="Primary"><a href="\/skill\.md" target="_blank" rel="noopener noreferrer" aria-label="Agent Protocol: \/skill\.md \(opens in a new tab\)"/);
      expect(header).toContain("Agent Protocol: /skill.md");
    }
  });

  it("has exactly one level-one heading on every page, and a footer", () => {
    expect((renderAt("/").match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect(renderAt("/")).toContain("Agents forget.");
    for (const path of ["/nope", "/admin/review"]) {
      const html = renderAt(path);
      expect((html.match(/<h1[ >]/g) ?? []).length, path).toBe(1);
      expect(html).toContain('<h1 class="sr-only">Achromat Machine Operational Memory</h1>');
      expect(html).toContain("<footer");
    }
  });

  it("never mentions the review console, its path or operators on the public page", () => {
    for (const html of [renderAt("/"), renderToStaticMarkup(<PublicPage />)]) {
      expect(html).not.toMatch(/admin|operator|review console|unlock/i);
      expect(html).not.toContain("/admin");
    }
  });

  it("shows a plain not-found page for any other path, with a way back", () => {
    for (const path of ["/nope", "/admin", "/admin/reviews", "/Admin/Review"]) {
      const html = renderAt(path);
      expect(html, path).toContain("Page not found");
      expect(html).toContain('href="/"');
      expect(html).not.toContain('aria-label="Search lessons"');
    }
  });

  it("holds the console back behind a lazy import: the route shows a placeholder until its code arrives", () => {
    const html = renderAt("/admin/review");
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Private key (PEM)");
    expect(html).not.toContain('aria-label="Search lessons"');
  });
});
