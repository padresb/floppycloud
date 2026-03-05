import { Env } from "./types";

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface TurnCredentials {
  iceServers: IceServer[];
  ttl: number;
}

interface TurnApiResponse {
  iceServers: IceServer | IceServer[];
}

export async function getTurnCredentials(env: Env): Promise<TurnCredentials> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_CALLS_APP_ID}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_CALLS_APP_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86400 }), // 24h credential TTL
    }
  );

  if (!response.ok) {
    throw new Error(`TURN credential fetch failed: ${response.status}`);
  }

  const data = await response.json() as TurnApiResponse;
  const turnServers = Array.isArray(data.iceServers)
    ? data.iceServers
    : [data.iceServers];

  // Always include public STUN as primary (free, no relay)
  return {
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      ...turnServers,
    ],
    ttl: 86400,
  };
}
