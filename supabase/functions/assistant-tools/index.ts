const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Internal-Secret",
};

type ToolRequest = {
  action: "get_user_profile" | "allow_long_reply" | "close_conversation";
  user_id: string;
  conversation_id: string;
  args?: Record<string, unknown>;
};

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function sbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function sbGet(url: string, key: string, path: string): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: sbHeaders(key) });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
  return res.json();
}

async function sbPatch(url: string, key: string, table: string, filter: string, body: object): Promise<void> {
  const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status}`);
}

function validParts(value: unknown): value is 1 | 3 | 4 {
  return value === 1 || value === 3 || value === 4;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("ASSISTANT_TOOLS_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!expectedSecret || req.headers.get("X-Internal-Secret") !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let input: ToolRequest;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!input?.action || !input.user_id || !input.conversation_id) {
    return json({ error: "action, user_id and conversation_id are required" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server configuration error" }, 500);

  try {
    const conversations = await sbGet(url, key, `conversations?id=eq.${encodeURIComponent(input.conversation_id)}&user_id=eq.${encodeURIComponent(input.user_id)}&select=id,status`);
    if (conversations.length !== 1) return json({ error: "Conversation not found" }, 404);

    if (input.action === "get_user_profile") {
      const allowed = new Set(["name", "home", "work", "transport", "home_station", "work_station", "max_reply_sms_parts"]);
      const requested = Array.isArray(input.args?.fields)
        ? input.args!.fields.filter((field): field is string => typeof field === "string" && allowed.has(field))
        : [];
      const fields = requested.length ? requested : ["name", "home", "work", "transport", "home_station", "work_station", "max_reply_sms_parts"];
      const users = await sbGet(url, key, `users?id=eq.${encodeURIComponent(input.user_id)}&select=profile_name,profile_home,profile_work,profile_transport,profile_home_station,profile_work_station,profile_max_reply_sms_parts`);
      const user = users[0] as Record<string, unknown> | undefined;
      if (!user) return json({ error: "User not found" }, 404);
      const source: Record<string, unknown> = {
        name: user.profile_name, home: user.profile_home, work: user.profile_work,
        transport: user.profile_transport, home_station: user.profile_home_station,
        work_station: user.profile_work_station, max_reply_sms_parts: user.profile_max_reply_sms_parts,
      };
      return json({ profile: Object.fromEntries(fields.filter((field) => source[field] != null).map((field) => [field, source[field]])) });
    }

    if (input.action === "allow_long_reply") {
      const users = await sbGet(url, key, `users?id=eq.${encodeURIComponent(input.user_id)}&select=profile_max_reply_sms_parts`);
      const user = users[0] as { profile_max_reply_sms_parts?: number } | undefined;
      if (!user) return json({ error: "User not found" }, 404);
      const requested = input.args?.parts;
      if (!validParts(requested) || requested === 1) return json({ error: "parts must be 3 or 4" }, 400);
      const cap = validParts(user.profile_max_reply_sms_parts) ? user.profile_max_reply_sms_parts : 4;
      const granted = Math.min(requested, cap) as 1 | 3 | 4;
      await sbPatch(url, key, "conversations", `id=eq.${encodeURIComponent(input.conversation_id)}`, {
        reply_sms_parts: granted,
        extended_mode: granted > 1,
        pending_reply: null,
        last_activity_at: new Date().toISOString(),
      });
      return json({ granted_parts: granted });
    }

    if (input.action === "close_conversation") {
      await sbPatch(url, key, "conversations", `id=eq.${encodeURIComponent(input.conversation_id)}`, {
        status: "closed",
        pending_reply: null,
        last_activity_at: new Date().toISOString(),
      });
      return json({ closed: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("assistant-tools error", String(error));
    return json({ error: "Tool execution failed" }, 500);
  }
});
