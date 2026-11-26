// The authoritative board. Every op from every connection passes through
// `handle` one at a time (Node's event loop + a synchronous SQLite write), so
// the server defines a single total order and assigns each accepted op the next
// seq. Clients never merge with each other; they only follow this order.
//
// The room does not know about sockets: a Conn is anything with send/close,
// which is what lets the tests drive it without a network.

import { applyOp, columnCards, type Board, type Op } from "../src/shared/board.ts";
import { clientMessageSchema, type Committed, type Presence, type ServerMessage } from "../src/shared/protocol.ts";
import { rankBetween } from "../src/shared/rank.ts";
import type { Store } from "./store.ts";

export interface Conn {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface RoomOptions {
  /** Max ops replayed on reconnect before falling back to a snapshot. */
  catchUpLimit?: number;
  /** Presence updates are coalesced into one broadcast per this many ms. */
  presenceIntervalMs?: number;
  /** Token bucket per connection: sustained msgs/sec and burst size. */
  ratePerSec?: number;
  burst?: number;
  now?: () => number;
}

interface Session {
  clientId: string | null;
  presence: Presence | null;
  tokens: number;
  refilledAt: number;
}

export class Room {
  private board: Board;
  private seq: number;
  private readonly sessions = new Map<Conn, Session>();
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<RoomOptions>;

  private readonly store: Store;

  // No constructor parameter properties: Node runs this file with type
  // stripping, which only supports erasable TypeScript syntax.
  constructor(store: Store, opts: RoomOptions = {}) {
    this.store = store;
    this.opts = {
      catchUpLimit: 500,
      presenceIntervalMs: 50,
      ratePerSec: 30,
      burst: 60,
      now: Date.now,
      ...opts,
    };
    const loaded = store.load();
    this.board = loaded.board;
    this.seq = loaded.seq;
  }

  get state(): { board: Board; seq: number } {
    return { board: this.board, seq: this.seq };
  }

  get connections(): number {
    return this.sessions.size;
  }

  open(conn: Conn): void {
    this.sessions.set(conn, { clientId: null, presence: null, tokens: this.opts.burst, refilledAt: this.opts.now() });
  }

  close(conn: Conn): void {
    const s = this.sessions.get(conn);
    this.sessions.delete(conn);
    if (s?.presence) this.schedulePresence();
  }

  /** Raw text frame from a connection. */
  receive(conn: Conn, raw: string): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    if (!this.takeToken(s)) {
      conn.send({ t: "error", message: "rate limit exceeded" });
      conn.close(1008, "rate limit");
      this.close(conn);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      conn.send({ t: "error", message: "malformed JSON" });
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      conn.send({ t: "error", message: "invalid message" });
      return;
    }
    const msg = parsed.data;

    if (msg.t === "ping") {
      conn.send({ t: "pong" });
      return;
    }
    if (msg.t === "hello") {
      this.hello(conn, s, msg.clientId, msg.lastSeq, msg.presence);
      return;
    }
    if (!s.clientId) {
      conn.send({ t: "error", message: "hello first" });
      return;
    }
    if (msg.t === "presence") {
      s.presence = { clientId: s.clientId, ...msg.presence };
      this.schedulePresence();
      return;
    }
    this.op(conn, s.clientId, msg.clientOpId, msg.op);
  }

  private hello(conn: Conn, s: Session, clientId: string, lastSeq: number, presence: Omit<Presence, "clientId">) {
    // Same tab reconnecting while its old socket is still half-open: the new
    // connection wins, otherwise presence would show the person twice.
    for (const [other, os] of this.sessions) {
      if (other !== conn && os.clientId === clientId) {
        other.close(4000, "replaced by a newer connection");
        this.sessions.delete(other);
      }
    }
    s.clientId = clientId;
    s.presence = { clientId, ...presence };

    // A client from the future (server state was reset) or too far behind gets
    // a snapshot; otherwise just the ops it missed, which keeps reconnects cheap.
    const ops = lastSeq > this.seq ? null : this.store.opsSince(lastSeq, this.opts.catchUpLimit);
    if (lastSeq === 0 || ops === null) {
      conn.send({ t: "welcome", seq: this.seq, snapshot: this.board, ops: [], presence: this.presenceList() });
    } else {
      conn.send({ t: "welcome", seq: this.seq, snapshot: null, ops, presence: this.presenceList() });
    }
    this.schedulePresence();
  }

  private op(conn: Conn, clientId: string, clientOpId: string, requested: Op) {
    // Idempotency: a resend of something already applied gets its seq back
    // instead of being applied twice.
    const prior = this.store.seqOf(clientOpId);
    if (prior !== null) {
      conn.send({ t: "dup", clientOpId, seq: prior });
      return;
    }

    const op = this.resolveRankCollision(requested);
    const result = applyOp(this.board, op);
    if (!result.ok) {
      const id = op.kind === "create" ? op.card.id : op.id;
      conn.send({ t: "reject", clientOpId, reason: result.reason, card: this.board[id] ?? null });
      return;
    }

    const entry: Committed = { seq: this.seq + 1, op, clientOpId, clientId };
    const cardId = op.kind === "create" ? op.card.id : op.id;
    this.store.commit(entry, result.board[cardId] ?? null, cardId);
    this.board = result.board;
    this.seq = entry.seq;
    this.broadcast({ t: "op", ...entry });
  }

  /** Two people dropping a card into the same gap at the same moment compute
   * the same rank. The second one is nudged just after the first, so ranks in a
   * column stay unique and every client agrees on the order. */
  private resolveRankCollision(op: Op): Op {
    if (op.kind !== "create" && op.kind !== "move") return op;
    const movingId = op.kind === "create" ? op.card.id : op.id;
    const column = op.kind === "create" ? op.card.column : op.column;
    const rank = op.kind === "create" ? op.card.rank : op.rank;
    const others = columnCards(this.board, column).filter((c) => c.id !== movingId);
    if (!others.some((c) => c.rank === rank)) return op;
    const next = others.find((c) => c.rank > rank);
    let fixed: string;
    try {
      fixed = rankBetween(rank, next ? next.rank : null);
    } catch {
      return op; // invalid rank: let applyOp reject it
    }
    return op.kind === "create" ? { ...op, card: { ...op.card, rank: fixed } } : { ...op, rank: fixed };
  }

  private takeToken(s: Session): boolean {
    const now = this.opts.now();
    s.tokens = Math.min(this.opts.burst, s.tokens + ((now - s.refilledAt) / 1000) * this.opts.ratePerSec);
    s.refilledAt = now;
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  }

  private presenceList(): Presence[] {
    const list: Presence[] = [];
    for (const s of this.sessions.values()) if (s.presence) list.push(s.presence);
    return list.sort((a, b) => (a.clientId < b.clientId ? -1 : 1));
  }

  private schedulePresence() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.broadcast({ t: "presence", presence: this.presenceList() });
    }, this.opts.presenceIntervalMs);
  }

  private broadcast(msg: ServerMessage) {
    for (const [conn, s] of this.sessions) if (s.clientId) conn.send(msg);
  }

  dispose() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
  }
}

