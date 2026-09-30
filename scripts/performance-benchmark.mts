import { performance } from "node:perf_hooks";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const baseUrl = argument("--base-url");
if (!baseUrl) throw new Error("Pass --base-url=http://localhost:<port> for an authenticated app instance.");
const base = new URL(baseUrl);
if (!['http:', 'https:'].includes(base.protocol)) throw new Error("Use an HTTP app URL.");
const iterations = Math.max(5, Math.min(100, Math.trunc(Number(argument("--iterations") ?? 10)) || 10));
const headers: Record<string, string> = {};
if (process.env.WAXON_BENCHMARK_COOKIE) headers.Cookie = process.env.WAXON_BENCHMARK_COOKIE;
const results = [];
for (const path of ["/api/v2/library", "/api/v2/review/queue", "/api/v2/review/summary", "/api/v2/tags", "/api/v2/settings", "/api/admin/traces"]) {
  const samples: number[] = [];
  let bytes = 0;
  let serverTiming: string | null = null;
  for (let index = 0; index <= iterations; index++) {
    const start = performance.now();
    const response = await fetch(new URL(path, base), { headers, redirect: "error" });
    const body = await response.text();
    if (!response.ok) throw new Error(`${path} returned ${response.status}; verify access before benchmarking.`);
    bytes = Buffer.byteLength(body);
    serverTiming = response.headers.get("server-timing");
    if (index) samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]);
  results.push({ path, samples: samples.length, medianMs: percentile(0.5), observedP95Ms: percentile(0.95), bytes, serverTiming });
}
console.log(JSON.stringify({ note: "Warm sequential HTTP samples. These are not production percentiles or browser frame timings.", results }, null, 2));
