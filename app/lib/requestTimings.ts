import { NextResponse } from "next/server";

/** Per-request phase durations, visible in browser network tools without private data. */
export class RequestTimings {
  private last = performance.now();
  private phases: string[] = [];

  mark(name: string) {
    const now = performance.now();
    this.phases.push(`${name};dur=${(now - this.last).toFixed(1)}`);
    this.last = now;
  }

  json(body: unknown, init?: ResponseInit) {
    const response = NextResponse.json(body, init);
    this.mark("serialize");
    response.headers.set("Server-Timing", this.phases.join(", "));
    return response;
  }
}
