import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  dropConnection,
  guardConnection,
  queuedBytes,
  queuedPackets,
  STALL_WINDOW_MS,
  stalledOverCap,
} from "../src/outbound";
import { connectNamespace } from "../src/server";

/**
 * A stand-in for an Engine.IO connection whose write buffer records every way it is read
 * packet by packet (an index or an iterator). Reading its length is not counted.
 */
function fakeConnection() {
  const walked: Array<string | symbol> = [];
  const packets: unknown[] = [];
  const writeBuffer = new Proxy(packets, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || /^\d+$/.test(key)) walked.push(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const transport = {
    socket: { bufferedAmount: 0, terminate: () => {}, _socket: { _handle: { writeQueueSize: 0 } } },
  };
  const conn = Object.assign(new EventEmitter(), { writeBuffer, transport });
  guardConnection(conn, () => {});
  return {
    conn,
    walked,
    transport,
    /** What Engine.IO does for each packet it queues. */
    queue(data: string | Uint8Array) {
      conn.emit("packetCreate", { type: "message", data });
      packets.push({ type: "message", data });
    },
    /** What Engine.IO does when the transport is free: everything moves at once. */
    flush() {
      conn.emit("flush", packets);
      packets.length = 0;
    },
  };
}

describe("measuring what is queued for a connection", () => {
  it("counts bytes and packets without reading the packets in the buffer", () => {
    const small = fakeConnection();
    for (let i = 0; i < 10; i += 1) small.queue("abcd");
    expect(queuedBytes(small.conn)).toBe(40);
    expect(queuedPackets(small.conn)).toBe(10);

    const large = fakeConnection();
    for (let i = 0; i < 100_000; i += 1) large.queue("abcd");
    expect(queuedBytes(large.conn)).toBe(400_000);
    expect(queuedPackets(large.conn)).toBe(100_000);

    // The same two calls on a queue ten thousand times longer read no packet at all.
    expect(small.walked).toEqual([]);
    expect(large.walked).toEqual([]);
  });

  it("counts binary packets by their length and ignores packets without data", () => {
    const c = fakeConnection();
    c.queue(new Uint8Array(1000));
    c.conn.emit("packetCreate", { type: "ping" });
    expect(queuedBytes(c.conn)).toBe(1000);
  });

  it("drops the count when the buffer is handed to the transport, and adds what the socket holds", () => {
    const c = fakeConnection();
    c.queue(new Uint8Array(5000));
    c.flush();
    expect(queuedBytes(c.conn)).toBe(0);
    expect(queuedPackets(c.conn)).toBe(0);
    c.transport.socket.bufferedAmount = 7000;
    c.queue(new Uint8Array(300));
    expect(queuedBytes(c.conn)).toBe(7300);
  });

  it("closes a connection by terminating its socket and telling Engine.IO at once", () => {
    const calls: string[] = [];
    const conn = {
      transport: { socket: { terminate: () => calls.push("terminate") } },
      onClose: (reason: string) => calls.push(`onClose:${reason}`),
    };
    dropConnection(conn);
    expect(calls).toEqual(["terminate", "onClose:forced close"]);
  });
});

describe("the namespace a CONNECT packet names", () => {
  it("is / for a CONNECT with no namespace, an auth payload, or an explicit /", () => {
    expect(connectNamespace("0")).toBe("/");
    expect(connectNamespace('0{"token":"a,b/c"}')).toBe("/");
    expect(connectNamespace("0/,")).toBe("/");
    expect(connectNamespace('0/,{"token":"t"}')).toBe("/");
    expect(connectNamespace("0/")).toBe("/");
  });

  it("is the name for any other namespace, with or without a payload", () => {
    expect(connectNamespace("0/x,")).toBe("/x");
    expect(connectNamespace('0/admin,{"token":"t"}')).toBe("/admin");
    expect(connectNamespace("0/x")).toBe("/x");
    expect(connectNamespace("0/?a=1,")).toBe("/?a=1");
  });

  it("is null for a packet that is not a CONNECT", () => {
    expect(connectNamespace('2["sync"]')).toBeNull();
    expect(connectNamespace("1/x,")).toBeNull();
    expect(connectNamespace("")).toBeNull();
  });
});

describe("a connection that is over a cap and not draining", () => {
  /** A connection whose queue is whatever the test sets, for the sweep to look at. */
  function queued() {
    const c = fakeConnection();
    let now = 1_000_000;
    return {
      conn: c.conn,
      queue: c.queue,
      setBytes(bytes: number) {
        c.transport.socket.bufferedAmount = bytes;
      },
      setPending(pending: number) {
        c.transport.socket._socket._handle.writeQueueSize = pending;
      },
      /** A sweep `afterMs` after the last one. */
      sweep(afterMs: number, maxBytes = 4_000_000, maxPackets = 1000) {
        now += afterMs;
        return stalledOverCap(c.conn, maxBytes, maxPackets, now);
      },
    };
  }

  it("is left alone while its queue shrinks between sweeps, however long it is over the cap", () => {
    const q = queued();
    q.setBytes(20_000_000);
    q.sweep(0);
    for (let bytes = 19_000_000; bytes > 4_000_000; bytes -= 500_000) {
      q.setBytes(bytes);
      expect(q.sweep(500)).toBe(false);
    }
  });

  it("is closed only after the stall window with no progress, not at the second sweep", () => {
    const q = queued();
    q.setBytes(14_000_000);
    expect(q.sweep(0)).toBe(false);
    for (let elapsed = 500; elapsed < STALL_WINDOW_MS; elapsed += 500) {
      expect(q.sweep(500)).toBe(false);
    }
    expect(q.sweep(500)).toBe(true);
  });

  it("is left alone when progress comes in steps that are further apart than one sweep", () => {
    // A bursty reader: nothing moves for 700 ms, then the kernel takes a burst.
    const q = queued();
    q.setBytes(14_000_000);
    q.setPending(14_000_000);
    q.sweep(0);
    let pending = 14_000_000;
    for (let burst = 0; burst < 8; burst += 1) {
      expect(q.sweep(500)).toBe(false);
      expect(q.sweep(500)).toBe(false);
      pending -= 1_500_000;
      q.setPending(pending);
    }
  });

  it("is left alone while the kernel keeps taking bytes, though a message still being written counts in full", () => {
    // A WebSocket reports a message it is writing as queued in full until its last byte is out.
    const q = queued();
    q.setBytes(14_000_000);
    q.setPending(14_000_000);
    q.sweep(0);
    for (const pending of [11_000_000, 8_000_000, 5_000_000]) {
      q.setPending(pending);
      expect(q.sweep(2000)).toBe(false);
    }
    // The kernel stops taking bytes: closed once the window has passed.
    expect(q.sweep(1000)).toBe(false);
    expect(q.sweep(STALL_WINDOW_MS)).toBe(true);
  });

  it("is not stalled while under every cap, and its window starts when it goes over", () => {
    const q = queued();
    q.setBytes(1_000_000);
    expect(q.sweep(0)).toBe(false);
    expect(q.sweep(10_000)).toBe(false);
    q.setBytes(9_000_000);
    expect(q.sweep(500)).toBe(false);
    expect(q.sweep(STALL_WINDOW_MS - 500)).toBe(false);
    expect(q.sweep(500)).toBe(true);
  });

  it("counts packets the same way", () => {
    const q = queued();
    for (let i = 0; i < 50; i += 1) q.queue("a");
    expect(q.sweep(0, 1_000_000, 10)).toBe(false);
    expect(q.sweep(STALL_WINDOW_MS - 1, 1_000_000, 10)).toBe(false);
    expect(q.sweep(1, 1_000_000, 10)).toBe(true);
  });
});
