// SyncClient with a fake socket that behaves like Node 22's WebSocket: closing
// it while it is still connecting never fires a close event. CI found the
// client stuck forever in that case; these pin the fix on any Node version.

import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncClient } from "../src/client/sync-client.ts";

class SilentSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: SilentSocket[] = [];
  readyState = SilentSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    SilentSocket.instances.push(this);
  }
  send() {}
  close() {
    this.closed = true; // and deliberately no onclose
  }
}

afterEach(() => {
  SilentSocket.instances = [];
  vi.useRealTimers();
});

function make(connectTimeoutMs = 1000) {
  return new SyncClient({
    url: "ws://test/ws",
    identity: { clientId: "c", name: "C", color: "#123456" },
    WebSocketImpl: SilentSocket as unknown as typeof WebSocket,
    connectTimeoutMs,
    backoffBaseMs: 10,
    backoffMaxMs: 10,
    random: () => 0.5,
  });
}

describe("SyncClient without close events", () => {
  it("a drop while connecting still reconnects", () => {
    vi.useFakeTimers();
    const c = make();
    c.start();
    expect(SilentSocket.instances).toHaveLength(1);
    c.dropConnection();
    expect(SilentSocket.instances[0]!.closed).toBe(true);
    expect(c.status).toBe("offline");
    vi.advanceTimersByTime(20);
    expect(SilentSocket.instances).toHaveLength(2);
    c.stop();
  });

  it("a connection that is never welcomed is abandoned after the timeout", () => {
    vi.useFakeTimers();
    const c = make(1000);
    c.start();
    vi.advanceTimersByTime(999);
    expect(SilentSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(30);
    expect(SilentSocket.instances[0]!.closed).toBe(true);
    expect(SilentSocket.instances.length).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  it("frames from an abandoned socket are ignored", () => {
    vi.useFakeTimers();
    const c = make();
    c.start();
    const old = SilentSocket.instances[0]!;
    const handler = old.onmessage;
    c.dropConnection();
    expect(old.onmessage).toBeNull();
    handler?.({ data: JSON.stringify({ t: "welcome", seq: 9, snapshot: {}, ops: [], presence: [] }) });
    c.stop();
  });

  it("stop() stops for good", () => {
    vi.useFakeTimers();
    const c = make();
    c.start();
    c.stop();
    vi.advanceTimersByTime(60_000);
    expect(SilentSocket.instances).toHaveLength(1);
    expect(c.status).toBe("offline");
  });
});
