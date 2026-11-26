// The socket side of the client: connect, say hello with the last seq we have,
// resend pending ops after a reconnect, back off on failure, and notice dead
// connections with an app-level ping. All state changes go through the pure
// functions in sync-state.ts.

import type { Op } from "../shared/board.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { addLocal, dismiss, initialState, receive, view, type SyncState } from "./sync-state.ts";

export type Status = "connecting" | "online" | "offline";

export interface Identity {
  clientId: string;
  name: string;
  color: string;
}

export interface SyncClientOptions {
  url: string;
  identity: Identity;
  /** Injected so tests can use Node's WebSocket and the browser uses its own. */
  WebSocketImpl?: typeof WebSocket;
  pingMs?: number;
  pongTimeoutMs?: number;
  /** Give up on a connection that has not been welcomed within this time. */
  connectTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  newId?: () => string;
}

type Listener = () => void;

export class SyncClient {
  state: SyncState = initialState;
  status: Status = "connecting";
  /** Number of welcomes received, i.e. successful (re)connections. */
  sessions = 0;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private listeners = new Set<Listener>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private connectDeadline: ReturnType<typeof setTimeout> | null = null;
  private presence = { editing: null as string | null, dragging: null as string | null };
  private readonly o: Required<SyncClientOptions>;

  constructor(opts: SyncClientOptions) {
    this.o = {
      WebSocketImpl: globalThis.WebSocket,
      pingMs: 10_000,
      pongTimeoutMs: 5_000,
      connectTimeoutMs: 10_000,
      backoffBaseMs: 250,
      backoffMaxMs: 10_000,
      random: Math.random,
      newId: () => crypto.randomUUID().replaceAll("-", ""),
      ...opts,
    };
  }

  get board() {
    return view(this.state);
  }

  /** Stable object for React's useSyncExternalStore; replaced on every change. */
  snapshot: { state: SyncState; status: Status; board: ReturnType<typeof view> } = {
    state: initialState,
    status: "connecting",
    board: {},
  };

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.stopPing();
    this.clearConnectDeadline();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close(1000, "bye");
    }
    this.setStatus("offline");
  }

  /** Drop the current socket as if the network blipped (tests, and the UI's
   * "simulate disconnect" button). The client reconnects on its own. */
  dropConnection(): void {
    this.drop(4001, "simulated drop");
  }

  /** Close the current socket and treat it as lost right away. We don't wait
   * for its close event: Node 22's WebSocket never fires one for a socket
   * closed while still connecting, which left the client stuck (found by the
   * chaos test in CI). Handlers are detached so late frames are ignored. */
  private drop(code: number, reason: string) {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    this.lost(ws);
  }

  private lost(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopPing();
    this.clearConnectDeadline();
    if (this.stopped) return;
    this.setStatus("offline");
    this.scheduleReconnect();
  }

  private clearConnectDeadline() {
    if (this.connectDeadline) clearTimeout(this.connectDeadline);
    this.connectDeadline = null;
  }

  /** Apply locally now, send to the server, and keep it pending until the
   * server's ordered stream confirms or rejects it. */
  submit(op: Op): string {
    const clientOpId = this.o.newId();
    this.state = addLocal(this.state, { clientOpId, op });
    this.send({ t: "op", clientOpId, op });
    this.emit();
    return clientOpId;
  }

  setPresence(patch: Partial<{ editing: string | null; dragging: string | null }>): void {
    const next = { ...this.presence, ...patch };
    if (next.editing === this.presence.editing && next.dragging === this.presence.dragging) return;
    this.presence = next;
    this.send({ t: "presence", presence: this.presencePayload() });
  }

  dismiss(noticeId: string): void {
    this.state = dismiss(this.state, noticeId);
    this.emit();
  }

  private presencePayload() {
    return { name: this.o.identity.name, color: this.o.identity.color, ...this.presence };
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    const ws = new this.o.WebSocketImpl(this.o.url);
    this.ws = ws;
    this.clearConnectDeadline();
    this.connectDeadline = setTimeout(() => {
      this.connectDeadline = null;
      if (this.ws === ws) this.drop(4004, "connect timeout");
    }, this.o.connectTimeoutMs);

    ws.onopen = () => {
      this.send({
        t: "hello",
        clientId: this.o.identity.clientId,
        lastSeq: this.state.ready ? this.state.seq : 0,
        presence: this.presencePayload(),
      });
      this.startPing();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => this.lost(ws);
    ws.onerror = () => {
      /* onclose follows and handles it */
    };
  }

  private onMessage(msg: ServerMessage) {
    if (msg.t === "pong") {
      if (this.pongDeadline) clearTimeout(this.pongDeadline);
      this.pongDeadline = null;
      return;
    }
    if (msg.t === "welcome") {
      this.sessions++;
      this.attempt = 0;
      this.clearConnectDeadline();
      this.setStatus("online", false);
    }
    const { state, effect } = receive(this.state, msg);
    this.state = state;
    if (effect.kind === "resend") {
      for (const p of effect.pending) this.send({ t: "op", clientOpId: p.clientOpId, op: p.op });
    } else if (effect.kind === "resync") {
      // Missed something: forget confirmed state and ask for a snapshot.
      this.state = { ...this.state, ready: false };
      this.drop(4002, "resync");
    }
    this.emit();
  }

  private send(msg: ClientMessage) {
    // While offline, ops just stay pending; the welcome after reconnect
    // triggers a resend of all of them, in order.
    if (this.ws && this.ws.readyState === this.o.WebSocketImpl.OPEN) {
      if (msg.t === "op" && !this.state.ready) return; // wait for welcome
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect() {
    // Full jitter: spreads a crowd of clients out after a server restart.
    const cap = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** this.attempt);
    const delay = Math.floor(this.o.random() * cap);
    this.attempt++;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.connect();
    }, delay);
    this.timers.add(t);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ t: "ping" });
      if (this.pongDeadline) return;
      this.pongDeadline = setTimeout(() => {
        this.pongDeadline = null;
        this.drop(4003, "no pong");
      }, this.o.pongTimeoutMs);
    }, this.o.pingMs);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    this.pingTimer = null;
    this.pongDeadline = null;
  }

  private setStatus(s: Status, notify = true) {
    if (this.status === s) return;
    this.status = s;
    if (notify) this.emit();
  }

  private emit() {
    this.snapshot = { state: this.state, status: this.status, board: view(this.state) };
    for (const fn of this.listeners) fn();
  }
}
