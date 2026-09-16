// Talks to tailscaled's LocalAPI over its Unix socket, the same API the `tailscale` CLI uses.

const SOCKET = "/var/run/tailscale/tailscaled.sock";

export interface Peer {
  /** First label of the node's MagicDNS name, e.g. `homelab`. */
  node: string;
  login: string;
}

export type Whois = (address: string) => Promise<Peer | null>;

async function localApi(path: string): Promise<Response> {
  return fetch(`http://local-tailscaled.sock/localapi/v0/${path}`, { unix: SOCKET });
}

export const tailscaleWhois: Whois = async (address) => {
  const response = await localApi(`whois?addr=${encodeURIComponent(address)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`tailscale whois ${address}: HTTP ${response.status}`);
  const body = (await response.json()) as {
    Node?: { Name?: string };
    UserProfile?: { LoginName?: string };
  };
  const node = body.Node?.Name?.split(".")[0];
  const login = body.UserProfile?.LoginName;
  return node && login ? { node, login } : null;
};

/** This machine's tailnet IPv4 address. Throws when tailscaled is not running. */
export async function tailscaleIPv4(): Promise<string> {
  const response = await localApi("status?peers=false");
  if (!response.ok) throw new Error(`tailscale status: HTTP ${response.status}`);
  const body = (await response.json()) as { BackendState: string; Self?: { TailscaleIPs?: string[] } };
  const ip = body.Self?.TailscaleIPs?.find((a) => !a.includes(":"));
  if (body.BackendState !== "Running" || !ip) {
    throw new Error(`tailscale is not running (state ${body.BackendState})`);
  }
  return ip;
}
