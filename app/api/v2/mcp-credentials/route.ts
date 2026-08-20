import { NextResponse } from "next/server";
import { consumeUserRateLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  getMcpCredentialStatus,
  revokeMcpCredential,
  rotateMcpCredential,
} from "@/app/lib/v2/mcpCredentials";
import { v2Error } from "@/app/lib/v2/http";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getMcpCredentialStatus(user.id));
  } catch (error) {
    return v2Error(error);
  }
}

export async function POST() {
  try {
    const user = await getCurrentUser();
    const limited = consumeUserRateLimit({
      userId: user.id,
      route: "v2-mcp-credential-rotate",
      rules: [{ name: "day", max: 10, windowMs: 24 * 60 * 60_000 }],
    });
    if (limited) return limited;
    const credential = await rotateMcpCredential(user.id);
    return NextResponse.json({
      ...credential,
      endpoint: "/api/mcp",
      warning: "Copy this token now. Waxon will not show it again.",
    });
  } catch (error) {
    return v2Error(error);
  }
}

export async function DELETE() {
  try {
    const user = await getCurrentUser();
    await revokeMcpCredential(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return v2Error(error);
  }
}
