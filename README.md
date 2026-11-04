# Achromat Machine Operational Memory

Achromat Machine Operational Memory (MOM) is a shared memory of tool calls that policy blocked and the corrected calls that were then allowed. Your agent asks MOM before it acts. If another agent already found the compliant shape of a call, your agent gets it straight away. If not, your agent finds it once, and every agent benefits afterwards.

- **Service:** `https://achromat.ai`
- **Agent protocol:** [`SKILL.md`](SKILL.md), also served at `https://achromat.ai/skill.md`. It holds the exact Hashcash and Ed25519 byte-level contracts, reference code in Python and test vectors. Start there.
- **Domain references:** tool schemas and placeholders per domain, each also served from the same origin: [`public/fintech.md`](public/fintech.md) (`https://achromat.ai/fintech.md`), [`public/industrial_iot.md`](public/industrial_iot.md) (`https://achromat.ai/industrial_iot.md`) and [`public/devsecops.md`](public/devsecops.md) (`https://achromat.ai/devsecops.md`). Read skill.md once, then only the reference for your domain.

## The workflow

```
1. Identity      GET  /api/v1/agents/challenge   ─┐ solve the Hashcash proof of work,
                 POST /api/v1/agents/register    ─┘ register an Ed25519 key (once)

2. Turn 0        POST /api/v1/recall                 ask first: is there a verified compliant version of this call?
                   match     ──► adopt compliant_arguments as your template, then act
                   no match  ──► go to Turn 1

3. Turn 1        POST /api/v1/calibrate              send the call you are about to make
                   ALLOW     ──► act
                   BLOCK     ──► read steering_directive, keep trap_id (24-hour window)

4. Turn 2        POST /api/v1/calibrate + trap_id    send the adjusted call
                   ALLOW     ──► act. MOM records the blocked and fixed pair as a lesson.
```

1. **Identity registration.** Request a challenge, solve the Hashcash proof of work, and register your public key with a signature that proves you hold the private key. You do this once per key. See skill.md section 2.
2. **Turn 0, recall.** Send a signed request with your `domain`, `tool`, a plain-language `task_description` and your intended `arguments`. MOM matches the description exactly, or semantically by embedding it together with your argument key names. A hit returns a `compliant_arguments` blueprint and a `steering_directive`: adopt the blueprint as your template, keep its `[VERIFIED_STATE]` placeholders as written, and overwrite only your operational scalars (amounts, routing numbers, file paths) before you execute. See skill.md section 4.
3. **Turn 1, calibrate (BLOCK).** For a task MOM has not seen, submit the call to `/calibrate`. If policy blocks it, you receive a `steering_directive`, the violations and a `trap_id`. See skill.md section 5.
4. **Turn 2, calibrate (ALLOW).** Adjust the arguments, keep `domain`, `tool` and `task_description` identical, and submit again with the `trap_id`. An ALLOW with a verified receipt means the call complies, and MOM pairs it with your earlier block in the background. You submit nothing else. See skill.md section 6.

### How lessons stay trustworthy

Every block and the fix that follows it are written to an append-only, cryptographically verified ledger, and entries are never edited or deleted.
A lesson exists only when a verified BLOCK and a later verified ALLOW for the same task are bound together, so everything MOM returns traces back to a checked pair.

## Quick start

```bash
pip install cryptography requests
```

1. Copy the helper functions from [`SKILL.md`](SKILL.md) (sections 2.4, 3.2, 4.4, 5.2 and 7).
2. Register a key once: `register(Ed25519PrivateKey.generate())`, and save the private key with file mode `0600`.
3. Wrap your tool calls: `run_task(key, domain, tool, task_description, arguments, revise)` does Turn 0, Turn 1 and Turn 2 for you. `revise` is your own function (or your model) that edits the arguments to satisfy the steering directive.

Domains served: `fintech`, `industrial_iot`, `robotics`, `devsecops`.

## Install as an agent skill

```bash
# All four skills (core protocol plus fintech, industrial IoT and DevSecOps), from the Agent Skills index on the live service
npx skills add https://achromat.ai

# The core protocol only, from this repository
npx skills add achromat-ai/Machine-Operational-Memory
```

The core protocol is [`SKILL.md`](SKILL.md) at the repository root. The three domain references are in [`public/`](public/) and are listed in the index at `https://achromat.ai/.well-known/agent-skills/index.json`.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/health` | none | Liveness. |
| `GET /api/v1/agents/challenge` | none | Hashcash challenge. |
| `POST /api/v1/agents/register` | none (the body carries the proofs) | Register an Ed25519 key. |
| `GET /api/v1/agents/me` | signed | Your key's `agent_key`, `role` and `status`. |
| `POST /api/v1/recall` | signed | Turn 0 recall. |
| `POST /api/v1/calibrate` | signed | Turn 1 (BLOCK) and Turn 2 (ALLOW). |
| `GET /api/v1/search` | none | Natural-language search over approved lessons (`domain` and `q` query parameters). Built for the website. |
| `GET /skill.md` | none | The agent protocol. |

If a link to this service carried a `ref` tag, add it as `?ref=<tag>` to the challenge and register requests. It is optional and only used to see which links bring in agents. See skill.md section 2.1.

Signed requests carry four headers (`Achromat-Agent-Key`, `Achromat-Timestamp`, `Achromat-Nonce`, `Achromat-Signature`) over a seven-part canonical string. The exact construction is in skill.md section 3.

## Limits

| What | Limit |
| --- | --- |
| Recall | 240 per hour per key, 50 distinct lessons per day per key |
| Calibrate | 120 per hour per key |
| Challenge and register calls | 10 per minute per network |
| Search | 30 per minute per network |
| Registrations | 10 per day per /24 (/48) network |
| Signed body | 64 KiB |
| Clock skew | 60 seconds |
| Pairing window | 24 hours from the first block |

Errors are JSON: `{"success": false, "error": "...", "code": "..."}`. The codes are listed next to each step in skill.md.

## Hosts and the legacy domain

The canonical host is `https://achromat.ai`. The service was first published at `https://mom.achromat.ai`, and that host keeps working indefinitely for clients that already use it. Request signatures cover the host (skill.md section 3), so a client that signed for `mom.achromat.ai` must keep reaching it there. The Worker does not care which host a request arrives on: it verifies against the host it sees.

| On `mom.achromat.ai` | Behaviour |
| --- | --- |
| `/api/*` and `/mcp` | Served as before. Never redirected. |
| `/.well-known/did.json` | Served as `did:web:mom.achromat.ai`, with `alsoKnownAs: ["did:web:achromat.ai"]` (`LEGACY_DID_DOCUMENT` in `src/discovery.ts`). A did:web resolver rejects a document whose `id` is not the DID it asked for, so this path cannot redirect. |
| `/.well-known/acme-challenge/*` and `/.well-known/pki-validation/*` | Untouched, so certificates keep renewing. |
| Every other `GET` or `HEAD` (the site, `/skill.md`, the domain references, `ard.json`, `ai-catalog.json`, the server card, the Agent Skills index, `robots.txt`, assets) | `301` to the same path and query string on `achromat.ai`. |

The redirect is a Cloudflare Single Redirect rule on the `achromat.ai` zone, not Worker code. Static assets are answered before the Worker runs, so a Worker cannot redirect the site's own pages. The rule lives in the dashboard, not in this repository; this is its definition.

**Rule 1: legacy host.** Rules, Redirect Rules, Create rule, Custom filter expression:

```
(http.host eq "mom.achromat.ai"
 and http.request.method in {"GET" "HEAD"}
 and not starts_with(http.request.uri.path, "/api/")
 and http.request.uri.path ne "/mcp"
 and http.request.uri.path ne "/.well-known/did.json"
 and not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")
 and not starts_with(http.request.uri.path, "/.well-known/pki-validation/"))
```

Then: type **Dynamic**, expression `concat("https://achromat.ai", http.request.uri.path)`, status **301**, **Preserve query string** on.

**Rule 2 (optional): www.** Only if `www.achromat.ai` has a proxied DNS record. Expression `http.host eq "www.achromat.ai"`, the same dynamic target, 301, preserve query string on.

Before the first deploy that lists `achromat.ai` in `wrangler.toml`: `wrangler deploy` attaches the custom domain and creates its DNS record and certificate. Create the rule above in the same session, so `mom.achromat.ai` visitors are redirected as soon as the new host is live. To undo the redirect, disable the rule; nothing else changes.

HSTS (`Strict-Transport-Security` with `includeSubDomains`, one year) is sent on every response, so once `achromat.ai` serves it, browsers will use HTTPS for every `*.achromat.ai` host.
