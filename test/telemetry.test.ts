import { describe, expect, it } from "vitest";
import { AGENT_ID_HEX_LENGTH, anonymiseAgentKey } from "../src/telemetry";
import { TOOL, TRAP_ARGUMENTS, FIX_ARGUMENTS, community, uniqueDescription } from "./fixtures/ledger";
import { ALLOW, mockRamen } from "./fixtures/ramen";
import { blockVerdict, freshWorld } from "./fixtures/world";

const DOMAIN = "fintech";

function query(description: string) {
  return { domain: DOMAIN, tool: TOOL, task_description: description, arguments: TRAP_ARGUMENTS };
}

describe("telemetry: agent anonymisation", () => {
  it("derives a stable, truncated SHA-256 id that is not the raw key", async () => {
    const { key } = await community();
    const id = await anonymiseAgentKey(key);
    expect(id).toMatch(new RegExp(`^[0-9a-f]{${AGENT_ID_HEX_LENGTH}}$`));
    expect(await anonymiseAgentKey(key)).toBe(id);
    expect(key).not.toContain(id);
    expect(await anonymiseAgentKey(`${key}0`)).not.toBe(id);
  });
});

describe("telemetry: /recall", () => {
  it("writes one miss data point with the anonymised agent id and nothing else identifying", async () => {
    const world = await freshWorld();
    const { agent, key } = await community();
    const description = uniqueDescription();
    const { status, json } = await world.recall(agent, query(description));
    expect(status).toBe(200);
    expect(json.match).toBe(false);

    const agentId = await anonymiseAgentKey(key);
    expect(world.analytics.points).toEqual([
      { indexes: [agentId], blobs: ["recall", DOMAIN, TOOL, agentId, "miss"], doubles: [1] },
    ]);
    const serialised = JSON.stringify(world.analytics.points);
    expect(serialised).not.toContain(key);
    expect(serialised).not.toContain(agent.publicKey);
    expect(serialised).not.toContain(description);
  });

  it("writes a hit when a lesson is served", async () => {
    const world = await freshWorld();
    const { agent, key } = await community();
    const { description } = await world.createLesson(agent);
    world.analytics.points.length = 0;
    const { json } = await world.recall(agent, query(description));
    expect(json.match).toBe(true);
    const agentId = await anonymiseAgentKey(key);
    expect(world.analytics.points).toEqual([
      { indexes: [agentId], blobs: ["recall", DOMAIN, TOOL, agentId, "hit"], doubles: [1] },
    ]);
  });

  it("writes nothing for a rejected request", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { status } = await world.recall(agent, { ...query(uniqueDescription()), domain: "healthcare" });
    expect(status).toBe(400);
    expect(world.analytics.points).toHaveLength(0);
  });

  it("still answers when the dataset write throws", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    world.analytics.fail = true;
    const { status, json } = await world.recall(agent, query(uniqueDescription()));
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, match: false });
  });
});

describe("telemetry: /calibrate", () => {
  it("labels Turn 1 as calibrate_trap/block and a Turn 2 with its trap_id as calibrate_fix/allow", async () => {
    const world = await freshWorld();
    const { agent, key } = await community();
    const description = uniqueDescription();
    const upstream = mockRamen(blockVerdict(), ALLOW);
    try {
      const turn1 = await world.calibrate(agent, { domain: DOMAIN, tool: TOOL, task_description: description, arguments: TRAP_ARGUMENTS });
      expect(turn1.json.trap.recorded).toBe(true);
      const turn2 = await world.calibrate(agent, {
        domain: DOMAIN,
        tool: TOOL,
        task_description: description,
        arguments: FIX_ARGUMENTS,
        trap_id: turn1.json.trap.trap_id,
      });
      expect(turn2.json.pairing.paired).toBe(true);
    } finally {
      upstream.restore();
    }
    const agentId = await anonymiseAgentKey(key);
    expect(world.analytics.points).toEqual([
      { indexes: [agentId], blobs: ["calibrate_trap", DOMAIN, TOOL, agentId, "block"], doubles: [1] },
      { indexes: [agentId], blobs: ["calibrate_fix", DOMAIN, TOOL, agentId, "allow"], doubles: [1] },
    ]);
    expect(JSON.stringify(world.analytics.points)).not.toContain(key);
  });

  it("writes nothing when the body is invalid (no upstream call)", async () => {
    const world = await freshWorld();
    const { agent } = await community();
    const { status } = await world.calibrate(agent, { domain: DOMAIN, tool: TOOL });
    expect(status).toBe(400);
    expect(world.analytics.points).toHaveLength(0);
  });
});
