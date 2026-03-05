import { TransferRoom } from "./room";
import { checkRateLimit, recordRequest } from "./ratelimit";
import { getTurnCredentials } from "./turn";
import { generatePhrase, isValidPhrase } from "./utils";
import { Env } from "./types";

export { TransferRoom };
export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ENVIRONMENT === "production"
        ? "https://floppy.cloud"
        : "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Global rate limit check (100/min per IP) before routing
    const globalLimited = await checkRateLimit(env, ip, "global", 100, 60);
    if (globalLimited) {
      return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });
    }
    await recordRequest(env, ip, "global");

    // --- POST /api/rooms — Create a new transfer session ---
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const limited = await checkRateLimit(env, ip, "create", 10, 60); // 10 creates/min per IP
      if (limited) return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });

      const phrase = generatePhrase(); // e.g. "golden-harbor"
      // Validate phrase format as defense-in-depth
      if (!isValidPhrase(phrase)) return new Response("Invalid phrase", { status: 400 });
      const id = env.TRANSFER_ROOM.idFromName(phrase);
      const stub = env.TRANSFER_ROOM.get(id);
      await recordRequest(env, ip, "create");

      return new Response(JSON.stringify({ phrase }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- GET /api/rooms/:code/ws — WebSocket upgrade (sender or receiver) ---
    if (request.method === "GET" && url.pathname.startsWith("/api/rooms/")) {
      const parts = url.pathname.split("/");
      const code = parts[3];
      const role = url.searchParams.get("role");

      if (!code || !role || !["sender", "receiver"].includes(role)) {
        return new Response("Bad request", { status: 400, headers: corsHeaders });
      }

      const limited = await checkRateLimit(env, ip, "ws", 30, 60); // 30 WS connections/min per IP
      if (limited) return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });

      const id = env.TRANSFER_ROOM.idFromName(code);
      const stub = env.TRANSFER_ROOM.get(id);
      return stub.fetch(new Request(
        `https://room/ws?role=${role}&code=${code}`,
        { headers: request.headers }
      ));
    }

    // --- GET /api/turn — Fetch ephemeral TURN credentials ---
    if (request.method === "GET" && url.pathname === "/api/turn") {
      const limited = await checkRateLimit(env, ip, "turn", 20, 60);
      if (limited) return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders });

      const credentials = await getTurnCredentials(env);
      return new Response(JSON.stringify(credentials), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
