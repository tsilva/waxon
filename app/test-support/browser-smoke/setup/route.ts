import { POST as setupBrowserSmoke } from "@/app/api/test-support/browser-smoke/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const response = await setupBrowserSmoke();
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  const status = response.status;
  const title = payload.ok
    ? "Browser smoke setup ready"
    : "Browser smoke setup failed";

  return new Response(
    `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><pre>${JSON.stringify(
      payload,
      null,
      2,
    )}</pre></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}
