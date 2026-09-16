#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createSlot, defaultAgentOptions, waitForSlot } from "./src/agent";

const USAGE = `Usage:
  slopshare create --name NAME --path PATH [--ttl SECONDS]
      Creates a slot and prints a link to send to the person with the secret. The value will be
      written to PATH on this machine.
  slopshare wait ID
      Blocks until the slot is filled, then writes the value to its path (0600).
      Prints the path and a confirmation code, never the value.

Environment:
  SLOPSHARE_URL   agent API, e.g. http://homelab.your-tailnet.ts.net:20161.
                  Falls back to the contents of ~/.config/slopshare/url.`;

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "create") {
    const options = await defaultAgentOptions();
    const { values } = parseArgs({
      args: rest,
      options: { name: { type: "string" }, path: { type: "string" }, ttl: { type: "string" } },
    });
    if (!values.name || !values.path) throw new Error(USAGE);
    const slot = await createSlot(options, {
      name: values.name,
      path: values.path,
      ttlSeconds: values.ttl ? Number(values.ttl) : undefined,
    });
    console.log(`link: ${slot.url}`);
    console.log(`id: ${slot.id}`);
    console.log(`expires: ${new Date(slot.expiresAt).toISOString()}`);
    console.log(`next: slopshare wait ${slot.id}`);
  } else if (command === "wait" && rest.length === 1) {
    const options = await defaultAgentOptions();
    const result = await waitForSlot(options, rest[0]!);
    console.log(`wrote ${result.path} (${result.bytes} bytes, confirm ${result.confirm})`);
  } else {
    console.log(USAGE);
    process.exit(command === "help" || command === "--help" ? 0 : 2);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
