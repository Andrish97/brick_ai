/**
 * zadarma-call-webhook
 * Handles Zadarma call events (NOTIFY_START, NOTIFY_ANSWER, NOTIFY_END, NOTIFY_RECORD).
 * Currently logs events to the `call_events` table.
 * Extend with IVR / TTS logic as needed.
 */

interface ZadarmaCallEvent {
  event: string;
  zd_echo?: string;
  call_start?: string;
  call_id_with_rec?: string;
  pbx_call_id?: string;
  caller_id?: string;
  called_did?: string;
  disposition?: string;
  duration?: string;
  record?: string;
  [key: string]: string | undefined;
}

async function saveCallEvent(
  supabaseUrl: string,
  supabaseKey: string,
  event: ZadarmaCallEvent,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/call_events`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      event_type: event.event,
      caller_id: event.caller_id ?? null,
      called_did: event.called_did ?? null,
      call_id: event.call_id_with_rec ?? event.pbx_call_id ?? null,
      disposition: event.disposition ?? null,
      duration: event.duration ? parseInt(event.duration) : null,
      record_url: event.record ?? null,
      raw_payload: event,
    }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const echo = url.searchParams.get("zd_echo");
    if (echo) return new Response(echo, { status: 200 });
    return new Response("OK", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: ZadarmaCallEvent;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      payload = await req.json();
    } else {
      const text = await req.text();
      const params = new URLSearchParams(text);
      payload = Object.fromEntries(params.entries()) as ZadarmaCallEvent;
    }
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (payload.zd_echo) {
    return new Response(payload.zd_echo, { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  await saveCallEvent(supabaseUrl, supabaseKey, payload);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
