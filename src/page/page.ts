import { seal } from "../crypto";

type Status = "open" | "filled" | "delivered" | "expired";

interface SlotView {
  id: string;
  name: string;
  path: string;
  node: string;
  publicKey: string;
  status: Status;
  expiresAt: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const value = $<HTMLTextAreaElement>("value");
const send = $<HTMLButtonElement>("send");
const after = $<HTMLParagraphElement>("after");
const countdown = $<HTMLTimeElement>("countdown");

const NEW_LINK = "Ask the agent for a new link.";
const CLOSED: Record<Exclude<Status, "open">, string> = {
  filled: `This slot already has a value. ${NEW_LINK}`,
  delivered: `This slot already has a value. ${NEW_LINK}`,
  expired: `This link has expired. ${NEW_LINK}`,
};

function problem(message: string) {
  form.hidden = true;
  const el = $("problem");
  el.textContent = message;
  el.hidden = false;
}

function tick(slot: SlotView, sealed: () => boolean): void {
  const left = Math.max(0, slot.expiresAt - Date.now());
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  countdown.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  countdown.dateTime = new Date(slot.expiresAt).toISOString();
  countdown.classList.toggle("low", left < 60_000);
  if (sealed()) {
    countdown.hidden = true;
    return;
  }
  if (left === 0) return problem(CLOSED.expired);
  setTimeout(() => tick(slot, sealed), 1000 - (Date.now() % 1000));
}

async function load() {
  const id = location.pathname.split("/").pop() ?? "";
  const linkKey = location.hash.slice(1);
  const response = await fetch(`/api/slots/${encodeURIComponent(id)}`);
  if (response.status === 404) return problem(`This link doesn't match any slot. ${NEW_LINK}`);
  if (response.status === 403) return problem("This page only opens for the Tailscale account that runs slopshare.");
  if (!response.ok) return problem(`The slot didn't load (HTTP ${response.status}). Reload to try again.`);
  const slot = (await response.json()) as SlotView;

  // The key in the link came from the agent, not from this server. Both have to agree.
  if (!linkKey || linkKey !== slot.publicKey) {
    return problem(`The key in this link doesn't match the slot. ${NEW_LINK}`);
  }
  if (slot.status !== "open") return problem(CLOSED[slot.status]);

  let sealed = false;
  $("node").textContent = slot.node;
  $("meta").hidden = false;
  $("name").textContent = slot.name;
  $("path").textContent = slot.path;
  send.textContent = `Send to ${slot.node}`;
  form.hidden = false;
  tick(slot, () => sealed);
  value.focus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Phone keyboards add trailing spaces. No secret we paste depends on edge whitespace.
    const text = value.value.trim();
    if (!text) {
      after.textContent = "Paste a value first.";
      after.classList.add("warn");
      return;
    }
    send.disabled = true;
    after.textContent = "";
    after.classList.remove("warn");
    try {
      const envelope = await seal(slot.publicKey, slot, text);
      const sent = await fetch(`/api/slots/${encodeURIComponent(slot.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
      });
      if (sent.status === 409) {
        const body = (await sent.json()) as { status: Exclude<Status, "open"> };
        return problem(CLOSED[body.status]);
      }
      if (!sent.ok) throw new Error(`HTTP ${sent.status}`);
    } catch (err) {
      after.textContent = `Couldn't send (${(err as Error).message}). Try again.`;
      after.classList.add("warn");
      send.disabled = false;
      return;
    }

    sealed = true;
    value.value = "";
    value.readOnly = true;
    $("stamp").textContent = "Sent";
    form.classList.add("sealed");
    after.textContent = `Waiting for ${slot.node} to pick it up.`;
    watchDelivery(slot);
  });
}

async function watchDelivery(slot: SlotView) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`/api/slots/${encodeURIComponent(slot.id)}`).catch(() => null);
    if (!response?.ok) continue;
    const { status } = (await response.json()) as SlotView;
    if (status === "delivered") {
      $("stamp").textContent = "Delivered";
      form.classList.add("delivered");
      after.textContent = `${slot.node} wrote it to the file.`;
      return;
    }
    if (status === "expired") {
      after.textContent = `${slot.node} didn't pick it up in time. ${NEW_LINK}`;
      after.classList.add("warn");
      return;
    }
  }
}

load().catch((err) => problem(`The slot didn't load (${(err as Error).message}). Reload to try again.`));
