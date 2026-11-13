import { formatNotificationEvent } from "@/lib/strategy-notification-events";
import { dingTalkSettings, localSettingsEnabled, strategyNotifier, type NotificationDelivery } from "@/lib/strategy-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deliveryStatus: Record<NotificationDelivery, number> = {
  sent: 200,
  duplicate: 200,
  paused: 200,
  unconfigured: 200,
  invalid: 503,
  "config-unavailable": 503,
  "rate-limited": 429,
  failed: 502,
};

function canConfigure(request: Request) {
  return localSettingsEnabled() && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.get("host") ?? "");
}

function validateRequest(request: Request) {
  const origin = URL.parse(request.headers.get("origin") ?? "");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== host ||
      (fetchSite !== null && fetchSite !== "same-origin")) {
    return Response.json({ status: "forbidden" }, { status: 403 });
  }
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ status: "invalid-event" }, { status: 415 });
  }
}

export async function GET(request: Request) {
  return Response.json({ status: await strategyNotifier.status(), canConfigure: canConfigure(request) }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PUT(request: Request) {
  if (!canConfigure(request)) return Response.json({ status: "forbidden" }, { status: 403 });
  const error = validateRequest(request);
  if (error) return error;
  const input = await request.json().catch(() => null);
  let status;
  if (typeof input?.webhook === "string" && input.webhook.length <= 2048 &&
      typeof input.secret === "string" && input.secret.length <= 256) {
    status = await dingTalkSettings.save({ webhook: input.webhook, secret: input.secret });
  } else if (typeof input?.enabled === "boolean" && !("webhook" in input)) {
    status = await dingTalkSettings.save({ enabled: input.enabled });
  } else {
    return Response.json({ status: "invalid" }, { status: 400 });
  }
  return Response.json({ status }, { status: status === "ready" || status === "paused" ? 200
    : status === "config-unavailable" ? 503 : 400 });
}

export async function POST(request: Request) {
  const error = validateRequest(request);
  if (error) return error;
  const event = await request.json().catch(() => null);
  const message = formatNotificationEvent(event);
  if (!message) return Response.json({ status: "invalid-event" }, { status: 400 });
  if (event.kind === "test" && event.text?.trim() && !canConfigure(request)) {
    return Response.json({ status: "forbidden" }, { status: 403 });
  }

  const status = await strategyNotifier.send(message);
  return Response.json({ status }, { status: deliveryStatus[status] });
}
