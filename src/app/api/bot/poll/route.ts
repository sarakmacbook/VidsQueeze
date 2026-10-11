import { NextResponse } from "next/server";
import { pollerSnapshot, startPolling, stopPolling } from "@/lib/poller";
import { longPollingBlockedReason, supportsLongPolling } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    poller: pollerSnapshot(),
    supported: supportsLongPolling(),
    blockedReason: longPollingBlockedReason(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action === "start" && !supportsLongPolling()) {
    return NextResponse.json(
      { started: false, error: longPollingBlockedReason(), poller: pollerSnapshot() },
      { status: 409 },
    );
  }
  if (body.action === "start") {
    const res = await startPolling();
    return NextResponse.json(
      { ...res, poller: pollerSnapshot() },
      { status: res.started ? 200 : 400 },
    );
  }
  if (body.action === "stop") {
    const res = await stopPolling();
    return NextResponse.json({ ...res, poller: pollerSnapshot() });
  }
  return NextResponse.json({ error: "action must be start or stop" }, { status: 400 });
}
