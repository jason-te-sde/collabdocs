import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { dropConnection, guardConnection, queuedBytes, queuedPackets } from "../src/outbound";
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
  const transport = { socket: { bufferedAmount: 0, terminate: () => {} } };
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
