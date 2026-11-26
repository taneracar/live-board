// Client-side sync state, as pure functions (no socket, no React), so the
// optimistic-update rules are unit-testable on their own.
//
// Model (the "rebase" approach used by Replicache and Figma-style editors):
//   confirmed  = the board as of the last server seq we have applied
//   pending    = our ops the server has not answered yet, in send order
//   view       = pending replayed on top of confirmed
// When the server's ordered stream says something happened, it goes into
// confirmed and the pending ops are replayed again on top. An op the server
// rejected is dropped and the person is told why. Nothing is ever merged by
// the client; the server's order is the truth.

import { applyOp, type Board, type Card, type Op } from "../shared/board.ts";
import type { Committed, Presence, ServerMessage } from "../shared/protocol.ts";

export interface Pending {
  clientOpId: string;
  op: Op;
}

export interface Notice {
  id: string;
  text: string;
}

export interface SyncState {
  confirmed: Board;
  seq: number;
  pending: readonly Pending[];
  presence: readonly Presence[];
  notices: readonly Notice[];
  /** True once a welcome has arrived; before that the board is unknown. */
  ready: boolean;
}

export const initialState: SyncState = {
  confirmed: {},
  seq: 0,
  pending: [],
  presence: [],
  notices: [],
  ready: false,
};

/** What the socket layer should do after a message. */
export type Effect = { kind: "none" } | { kind: "resend"; pending: readonly Pending[] } | { kind: "resync" };

export function view(state: SyncState): Board {
  let board = state.confirmed;
  for (const p of state.pending) {
    const r = applyOp(board, p.op);
    // An op that no longer applies (its card was deleted under us) simply has
    // no visible effect; the server's reject will remove it from pending.
    if (r.ok) board = r.board;
  }
  return board;
}

export function addLocal(state: SyncState, pending: Pending): SyncState {
  return { ...state, pending: [...state.pending, pending] };
}

function applyCommitted(state: SyncState, c: Committed): SyncState {
  const r = applyOp(state.confirmed, c.op);
  return {
    ...state,
    // The server already applied it, so it must apply here too; if it does not,
    // confirmed has diverged and the caller will resync from a snapshot.
    confirmed: r.ok ? r.board : state.confirmed,
    seq: c.seq,
    pending: state.pending.filter((p) => p.clientOpId !== c.clientOpId),
  };
}

export function receive(state: SyncState, msg: ServerMessage): { state: SyncState; effect: Effect } {
  switch (msg.t) {
    case "welcome": {
      let next: SyncState = { ...state, presence: msg.presence, ready: true };
      if (msg.snapshot) next = { ...next, confirmed: msg.snapshot, seq: msg.seq };
      for (const c of msg.ops) if (c.seq > next.seq) next = applyCommitted(next, c);
      // Whatever is still pending was never committed (or its commit is older
      // than the snapshot; the server answers those with "dup"). Send it again,
      // in order. Resends are safe: the server dedupes on clientOpId.
      return { state: next, effect: next.pending.length ? { kind: "resend", pending: next.pending } : { kind: "none" } };
    }
    case "op": {
      if (msg.seq <= state.seq) return { state, effect: { kind: "none" } }; // already have it
      if (msg.seq !== state.seq + 1) return { state, effect: { kind: "resync" } }; // gap
      const before = applyOp(state.confirmed, msg.op);
      if (!before.ok) return { state, effect: { kind: "resync" } }; // diverged
      return { state: applyCommitted(state, msg), effect: { kind: "none" } };
    }
    case "dup":
      return { state: { ...state, pending: state.pending.filter((p) => p.clientOpId !== msg.clientOpId) }, effect: { kind: "none" } };
    case "reject": {
      const dropped = state.pending.find((p) => p.clientOpId === msg.clientOpId);
      const pending = state.pending.filter((p) => p.clientOpId !== msg.clientOpId);
      const text = dropped ? explain(dropped.op, msg.reason, msg.card) : `Change rejected (${msg.reason}).`;
      return {
        state: { ...state, pending, notices: [...state.notices, { id: msg.clientOpId, text }].slice(-5) },
        effect: { kind: "none" },
      };
    }
    case "presence":
      return { state: { ...state, presence: msg.presence }, effect: { kind: "none" } };
    default:
      return { state, effect: { kind: "none" } };
  }
}

export function dismiss(state: SyncState, noticeId: string): SyncState {
  return { ...state, notices: state.notices.filter((n) => n.id !== noticeId) };
}

function explain(op: Op, reason: string, card: Card | null): string {
  if (reason === "stale-title" && op.kind === "rename" && card) {
    return `Someone renamed this card to “${card.title}” first, so your title “${op.to}” was not saved.`;
  }
  if (reason === "unknown-card") return "That card was deleted by someone else, so your change was not saved.";
  if (reason === "board-full") return "The board is full (500 cards).";
  return `Your change was rejected (${reason}).`;
}
