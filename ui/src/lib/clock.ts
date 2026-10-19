/**
 * Server clock offset. Every signed request carries a timestamp that must be within 60 seconds of the
 * server's clock, and a device clock can be minutes off. The offset is learned from the HTTP `Date`
 * header of any response (Cloudflare sets it on every response, including errors):
 *
 *   offset = serverTime - localTimeWhenTheResponseArrived
 *
 * `Date` has one-second resolution and the request takes some time to arrive, so the estimate is off by
 * a second or two. The 60-second window makes that irrelevant. The offset is kept in memory only.
 */
export class ServerClock {
  private offset = 0;
  private learned = false;

  /** Milliseconds to add to the local clock to get server time. 0 until a response has been observed. */
  get offsetMs(): number {
    return this.offset;
  }

  /** True once an offset has been learned from a response. */
  get isSynchronised(): boolean {
    return this.learned;
  }

  /** Server time for a local epoch-millisecond reading. */
  serverTime(localMs: number): number {
    return localMs + this.offset;
  }

  /**
   * Learns the offset from a response's Date header, measured against `receivedAtMs` (the local clock when
   * the response arrived). Returns false, changing nothing, if the header is missing or unparsable.
   */
  observe(response: Pick<Response, "headers">, receivedAtMs: number): boolean {
    const header = response.headers.get("Date");
    if (header === null) return false;
    const serverMs = Date.parse(header);
    if (!Number.isFinite(serverMs)) return false;
    this.offset = serverMs - receivedAtMs;
    this.learned = true;
    return true;
  }

  reset(): void {
    this.offset = 0;
    this.learned = false;
  }
}

/** The clock shared by the identity flow and the signed client. */
export const serverClock = new ServerClock();
