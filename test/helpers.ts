/** Test client: Ed25519 keys, Hashcash solving, registration and signed requests. */
import { exports } from "cloudflare:workers";
import {
  encodeBase64url,
  leadingZeroBits,
  powPreimage,
  registrationSigningString,
  requestSigningString,
  sha256Hex,
} from "../src/schema";

export const ORIGIN = "https://mom.achromat.ai";

let networkCounter = 0;
/** A fresh /24 per call, so tests never share rate-limit or registration-cap buckets. */
export function freshIp(): string {
  networkCounter += 1;
  return `10.${(networkCounter >> 8) & 255}.${networkCounter & 255}.7`;
}

export function call(path: string, init: RequestInit & { ip?: string | null } = {}): Promise<Response> {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (ip !== null) headers.set("CF-Connecting-IP", ip ?? freshIp());
  return exports.default.fetch(new Request(ORIGIN + path, { ...rest, headers }));
}

export interface TestAgent {
  keys: CryptoKeyPair;
  publicKey: string;
}

export async function newAgent(): Promise<TestAgent> {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return { keys, publicKey: encodeBase64url(raw) };
}

export async function sign(agent: TestAgent, message: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, agent.keys.privateKey, new TextEncoder().encode(message));
  return encodeBase64url(new Uint8Array(signature));
}

export async function solvePow(challenge: string, publicKey: string, bits: number): Promise<string> {
  for (let counter = 0; ; counter++) {
    const nonce = counter.toString(16);
    if (leadingZeroBits(await sha256Hex(powPreimage(challenge, publicKey, nonce))) >= bits) return nonce;
  }
}

/** A nonce whose digest does NOT meet the difficulty. */
export async function failingNonce(challenge: string, publicKey: string, bits: number): Promise<string> {
  for (let counter = 0; ; counter++) {
    const nonce = counter.toString(16);
    if (leadingZeroBits(await sha256Hex(powPreimage(challenge, publicKey, nonce))) < bits) return nonce;
  }
}

export interface Challenge {
  challenge_id: string;
  challenge: string;
  challenge_signature: string;
  difficulty_bits: number;
  expires_at: string;
}

export async function getChallenge(ip: string): Promise<Challenge> {
  const response = await call("/api/v1/agents/challenge", { ip });
  if (response.status !== 200) throw new Error(`challenge failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Challenge;
}

export async function registrationBody(agent: TestAgent, challenge: Challenge) {
  return {
    public_key: agent.publicKey,
    challenge_id: challenge.challenge_id,
    challenge_signature: challenge.challenge_signature,
    nonce: await solvePow(challenge.challenge, agent.publicKey, challenge.difficulty_bits),
    proof_signature: await sign(agent, registrationSigningString(challenge.challenge, agent.publicKey)),
  };
}

export function postRegister(body: unknown, ip: string): Promise<Response> {
  return call("/api/v1/agents/register", {
    method: "POST",
    ip,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Registers a new community key end to end and returns it. */
export async function registeredAgent(): Promise<TestAgent> {
  const ip = freshIp();
  const agent = await newAgent();
  const response = await postRegister(await registrationBody(agent, await getChallenge(ip)), ip);
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return agent;
}

export interface SignOptions {
  method?: string;
  body?: string;
  /** Host placed in the signed string (defaults to the request host). */
  signedHost?: string;
  /** Path+query placed in the signed string (defaults to the request path). */
  signedPath?: string;
  /** Body placed in the signed string (defaults to the sent body). */
  signedBody?: string;
  timestamp?: number;
  nonce?: string;
}

/** Builds the four Achromat-* headers for a request. */
export async function signatureHeaders(agent: TestAgent, path: string, options: SignOptions = {}): Promise<Headers> {
  const method = options.method ?? "GET";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const signingString = requestSigningString({
    host: options.signedHost ?? new URL(ORIGIN).host,
    method,
    pathAndQuery: options.signedPath ?? path,
    bodySha256Hex: await sha256Hex(options.signedBody ?? options.body ?? ""),
    timestamp,
    nonce,
  });
  return new Headers({
    "Achromat-Agent-Key": agent.publicKey,
    "Achromat-Timestamp": timestamp,
    "Achromat-Nonce": nonce,
    "Achromat-Signature": await sign(agent, signingString),
  });
}

export async function signedCall(agent: TestAgent, path: string, options: SignOptions = {}): Promise<Response> {
  const headers = await signatureHeaders(agent, path, options);
  const init: RequestInit & { ip?: string } = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) init.body = options.body;
  return call(path, init);
}
