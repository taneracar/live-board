import { useEffect, useMemo, useSyncExternalStore } from "react";
import { SyncClient, type Identity } from "../client/sync-client.ts";

const PALETTE = ["#c2410c", "#0f766e", "#7c3aed", "#be123c", "#1d4ed8", "#4d7c0f", "#a16207", "#0e7490"];

/** Name and colour persist per browser; clientId is per tab, so two tabs act
 * as two people (handy for trying it out). */
export function loadIdentity(): Identity {
  let clientId = sessionStorage.getItem("lb.clientId");
  if (!clientId) {
    clientId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    sessionStorage.setItem("lb.clientId", clientId);
  }
  const name = localStorage.getItem("lb.name") ?? `Guest ${Math.floor(100 + Math.random() * 900)}`;
  localStorage.setItem("lb.name", name);
  const color = PALETTE[parseInt(clientId.slice(0, 6), 16) % PALETTE.length]!;
  return { clientId, name, color };
}

export function useBoard(identity: Identity) {
  const client = useMemo(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return new SyncClient({ url: `${proto}//${location.host}/ws`, identity });
  }, [identity]);

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  const snap = useSyncExternalStore(
    (fn) => client.subscribe(fn),
    () => client.snapshot,
  );
  return { client, ...snap };
}
