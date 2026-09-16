# slopshare

Paste a secret on any of your tailnet devices, and it lands in a file on the machine where an agent asked for it.

1. An agent runs `slopshare create --name "openai key" --path ~/.config/foo/token` and sends you the link.
2. You open the link, paste the value, and see a six-digit code.
3. The agent runs `slopshare wait <id>`. It writes the file with mode 0600 and prints the same code.

## Security model

- The CLI generates a P-256 keypair for each slot and keeps the private key in `~/.local/state/slopshare/keys/`. The public key rides in the link's `#fragment`, which browsers never send to servers.
- The page encrypts in the browser (ECDH, HKDF-SHA256, AES-256-GCM) and uploads only ciphertext. The slot id, name and path are bound in as associated data, so if the server changes what the page shows, decryption fails and nothing gets written.
- Only one Tailscale login can open slot pages. `tailscale serve` sets `Tailscale-User-Login` and overwrites anything the client sends. Fills must come from the page's own origin, so another site open in the same browser can't post into a slot.
- Only allowlisted nodes can create or collect slots. The agent API binds the server's tailnet address and checks each caller with the tailscaled LocalAPI whois. It refuses requests that carry an `Origin` header, so browsers can't use it. A slot can only be collected by the node that created it.
- A slot takes one value. Open slots expire after 15 minutes by default. A filled value that never gets collected is wiped an hour after expiry, and a collected one is wiped right away. The row stays in SQLite as a record.
- The page and the CLI both show a code derived from the ciphertext, so you can check that what arrived is what you sent.

Caveats: the server serves the page's JavaScript, so a compromised server can read what gets typed into the page. Local processes on the server can reach the web port on 127.0.0.1 and forge the login header.

## Running

The server runs as a systemd user unit. It expects the repo at `~/dev/slopshare`.

```sh
mkdir -p ~/.config/slopshare
cp deploy/server.env.example ~/.config/slopshare/server.env   # then edit it
ln -s ~/dev/slopshare/deploy/slopshare.service ~/.config/systemd/user/
systemctl --user enable --now slopshare
tailscale serve --bg --https=20160 http://127.0.0.1:20160
ln -s ~/dev/slopshare/cli.ts ~/.local/bin/slopshare
echo http://your-server.your-tailnet.ts.net:20161 > ~/.config/slopshare/url
```

The CLI reads the agent API address from `SLOPSHARE_URL`, or from `~/.config/slopshare/url`. To use it on another allowlisted machine, clone the repo there, link `cli.ts`, and write the same `url` file.

```sh
bun test
bunx tsc --noEmit
```
