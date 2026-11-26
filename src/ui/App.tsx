import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { columnCards, COLUMNS, rankAt, type Board, type Card, type ColumnId } from "../shared/board.ts";
import type { Presence } from "../shared/protocol.ts";
import type { SyncClient } from "../client/sync-client.ts";
import { loadIdentity, useBoard } from "./useBoard.ts";

export function App() {
  const identity = useMemo(loadIdentity, []);
  const { client, state, status, board } = useBoard(identity);
  const others = state.presence.filter((p) => p.clientId !== identity.clientId);

  const statusText =
    status === "online"
      ? state.pending.length
        ? `Saving ${state.pending.length}…`
        : "Live"
      : status === "connecting"
        ? "Connecting…"
        : `Offline${state.pending.length ? ` · ${state.pending.length} unsaved` : ""}`;

  return (
    <div className="app">
      <header className="top">
        <h1>live-board</h1>
        <p className={`status status-${status}`} role="status" aria-live="polite" data-testid="status">
          <span className="dot" aria-hidden="true" />
          {statusText}
        </p>
        <ul className="people" aria-label="People on this board">
          <li className="person" style={{ "--c": identity.color } as React.CSSProperties} title={`${identity.name} (you)`}>
            <span aria-hidden="true">{initials(identity.name)}</span>
            <span className="sr-only">{identity.name} (you)</span>
          </li>
          {others.map((p) => (
            <li key={p.clientId} className="person" style={{ "--c": p.color } as React.CSSProperties} title={p.name}>
              <span aria-hidden="true">{initials(p.name)}</span>
              <span className="sr-only">{p.name}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="ghost" onClick={() => client.dropConnection()}>
          Simulate drop
        </button>
      </header>

      {!state.ready ? (
        <p className="loading">Loading board…</p>
      ) : (
        <main className="columns">
          {COLUMNS.map((col) => (
            <Column key={col.id} id={col.id} title={col.title} board={board} client={client} others={others} />
          ))}
        </main>
      )}

      <div className="notices" aria-live="assertive">
        {state.notices.map((n) => (
          <div key={n.id} className="notice" role="alert">
            <p>{n.text}</p>
            <button type="button" className="ghost" onClick={() => client.dismiss(n.id)}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

interface ColumnProps {
  id: ColumnId;
  title: string;
  board: Board;
  client: SyncClient;
  others: Presence[];
}

function Column({ id, title, board, client, others }: ColumnProps) {
  const cards = columnCards(board, id);
  const [draft, setDraft] = useState("");
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  function add() {
    const text = draft.trim();
    if (!text) return;
    const cardId = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    client.submit({ kind: "create", card: { id: cardId, column: id, rank: rankAt(board, id, cards.length), title: text } });
    setDraft("");
  }

  function indexFromPointer(e: DragEvent) {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])];
    const i = items.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i === -1 ? items.length : i;
  }

  return (
    <section
      className="column"
      aria-labelledby={`col-${id}`}
      data-column={id}
      onDragOver={(e) => {
        e.preventDefault();
        setDropIndex(indexFromPointer(e));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIndex(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const cardId = e.dataTransfer.getData("text/x-card");
        const dragged = board[cardId];
        if (dragged) {
          // Index among the cards as rendered, minus the dragged card if it sits above the drop point.
          let index = indexFromPointer(e);
          const from = cards.findIndex((c) => c.id === cardId);
          if (from !== -1 && from < index) index--;
          client.submit({ kind: "move", id: cardId, column: id, rank: rankAt(board, id, index, cardId) });
        }
        setDropIndex(null);
        client.setPresence({ dragging: null });
      }}
    >
      <h2 id={`col-${id}`}>
        {title} <span className="count">{cards.length}</span>
      </h2>
      <ol className="cards" ref={listRef}>
        {cards.map((card, i) => (
          <CardItem
            key={card.id}
            card={card}
            index={i}
            board={board}
            client={client}
            others={others}
            dropBefore={dropIndex === i}
          />
        ))}
        {dropIndex === cards.length && <li className="drop-line" aria-hidden="true" />}
      </ol>
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="sr-only" htmlFor={`add-${id}`}>
          New card in {title}
        </label>
        <input id={`add-${id}`} value={draft} maxLength={200} placeholder="Add a card" onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </section>
  );
}

interface CardProps {
  card: Card;
  index: number;
  board: Board;
  client: SyncClient;
  others: Presence[];
  dropBefore: boolean;
}

const ORDER = COLUMNS.map((c) => c.id);

function CardItem({ card, index, board, client, others, dropBefore }: CardProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.title);
  // What the title was when editing started: the rename is compare-and-set
  // against this, so a concurrent edit by someone else is never overwritten.
  const [base, setBase] = useState(card.title);
  const editors = others.filter((p) => p.editing === card.id);
  const movers = others.filter((p) => p.dragging === card.id);
  const col = ORDER.indexOf(card.column);
  const columnLength = columnCards(board, card.column).length;

  function move(column: ColumnId, toIndex: number) {
    client.submit({ kind: "move", id: card.id, column, rank: rankAt(board, column, toIndex, card.id) });
  }
  const moves = {
    up: () => index > 0 && move(card.column, index - 1),
    down: () => index < columnLength - 1 && move(card.column, index + 1),
    left: () => col > 0 && move(ORDER[col - 1]!, index),
    right: () => col < ORDER.length - 1 && move(ORDER[col + 1]!, index),
  };

  function startEdit() {
    setText(card.title);
    setBase(card.title);
    setEditing(true);
    client.setPresence({ editing: card.id });
  }
  function finishEdit(save: boolean) {
    setEditing(false);
    client.setPresence({ editing: null });
    const next = text.trim();
    if (save && next && next !== base) client.submit({ kind: "rename", id: card.id, from: base, to: next });
  }

  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (!e.altKey || e.target !== e.currentTarget) return;
    const map: Record<string, () => unknown> = { ArrowUp: moves.up, ArrowDown: moves.down, ArrowLeft: moves.left, ArrowRight: moves.right };
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
    // Keep focus on the card after it re-renders in its new place.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${card.id}"]`)?.focus());
  }

  const busy = editors[0] ?? movers[0];

  return (
    <>
      {dropBefore && <li className="drop-line" aria-hidden="true" />}
      <li
        className={`card${busy ? " card-busy" : ""}`}
        style={busy ? ({ "--c": busy.color } as React.CSSProperties) : undefined}
        data-card={card.id}
        tabIndex={0}
        aria-label={`${card.title}. Alt plus arrow keys to move.`}
        draggable={!editing}
        onKeyDown={onKey}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-card", card.id);
          e.dataTransfer.effectAllowed = "move";
          client.setPresence({ dragging: card.id });
        }}
        onDragEnd={() => client.setPresence({ dragging: null })}
      >
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              finishEdit(true);
            }}
          >
            <label className="sr-only" htmlFor={`edit-${card.id}`}>
              Card title
            </label>
            <input
              id={`edit-${card.id}`}
              autoFocus
              value={text}
              maxLength={200}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => finishEdit(true)}
              onKeyDown={(e) => e.key === "Escape" && finishEdit(false)}
            />
          </form>
        ) : (
          <p className="title">{card.title}</p>
        )}
        {busy && (
          <p className="busy">
            {busy.name} is {editors.length ? "editing" : "moving"} this
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={startEdit} disabled={editing}>
            Edit<span className="sr-only"> {card.title}</span>
          </button>
          <button type="button" onClick={moves.left} disabled={col === 0} aria-label={`Move ${card.title} left`}>
            ←
          </button>
          <button type="button" onClick={moves.right} disabled={col === ORDER.length - 1} aria-label={`Move ${card.title} right`}>
            →
          </button>
          <button type="button" onClick={moves.up} disabled={index === 0} aria-label={`Move ${card.title} up`}>
            ↑
          </button>
          <button type="button" onClick={moves.down} disabled={index === columnLength - 1} aria-label={`Move ${card.title} down`}>
            ↓
          </button>
          <button type="button" className="danger" onClick={() => client.submit({ kind: "delete", id: card.id })}>
            Delete<span className="sr-only"> {card.title}</span>
          </button>
        </div>
      </li>
    </>
  );
}
