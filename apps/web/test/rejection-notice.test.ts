import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { ConnectionStatus, describeConnection } from "@/components/editor/connection-status";
import { describeRejection, RejectionNotice } from "@/components/editor/rejection-notice";
import { CollabProvider, type SocketLike } from "@/lib/collab/provider";

class FakeSocket implements SocketLike {
  connected = false;
  auth: unknown = {};
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, handler: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (...args: unknown[]) => void);
    this.handlers.set(event, list);
    return this;
  }
  emit(): this {
    return this;
  }
  connect(): this {
    return this;
  }
  disconnect(): this {
    this.connected = false;
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  accept(): void {
    this.connected = true;
    this.fire("connect");
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function connected(role: "editor" | "viewer" = "editor") {
  const socket = new FakeSocket();
  const provider = new CollabProvider({
    documentId: "doc-1",
    doc: new Y.Doc(),
    url: "http://collab.test",
    fetchToken: async () => ({ token: "t", role }),
    createSocket: () => socket,
    network: { isOnline: () => true, subscribe: () => () => {} },
    random: () => 0.5,
  });
  provider.connect();
  await flush();
  socket.accept();
  const server = encoding.createEncoder();
  syncProtocol.writeSyncStep2(server, new Y.Doc());
  socket.fire("sync", encoding.toUint8Array(server));
  return { socket, provider };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the provider and a rejected notice", () => {
  for (const reason of ["document_full", "too_large", "forbidden", "overloaded", "malformed"]) {
    it(`records ${reason} and stops reporting a plain sync`, async () => {
      const { socket, provider } = await connected();
      expect(provider.getSnapshot().rejection).toBeNull();
      socket.fire("rejected", { event: "sync", reason });
      expect(provider.getSnapshot().rejection).toBe(reason);
      expect(provider.getSnapshot().unsynced).toBe(true);
      expect(describeConnection(provider.getSnapshot()).label).toBe("Changes not saved");
    });
  }

  it("treats a reason it does not know as a rejection too", async () => {
    const { socket, provider } = await connected();
    socket.fire("rejected", { event: "sync", reason: "something_new" });
    expect(provider.getSnapshot().rejection).toBe("unknown");
    socket.fire("rejected", undefined);
    expect(provider.getSnapshot().rejection).toBe("unknown");
  });

  it("ignores a refused awareness update, which loses nothing the user wrote", async () => {
    const { socket, provider } = await connected();
    socket.fire("rejected", { event: "awareness", reason: "too_large" });
    expect(provider.getSnapshot().rejection).toBeNull();
  });

  it("can be dismissed, and clears when a new connection finishes its sync handshake", async () => {
    const { socket, provider } = await connected();
    socket.fire("rejected", { event: "sync", reason: "document_full" });
    provider.dismissRejection();
    expect(provider.getSnapshot().rejection).toBeNull();

    socket.fire("rejected", { event: "sync", reason: "overloaded" });
    socket.connected = false;
    socket.fire("disconnect", "transport close");
    expect(provider.getSnapshot().rejection).toBe("overloaded");
    await vi.advanceTimersByTimeAsync(1000);
    socket.accept();
    const server = encoding.createEncoder();
    syncProtocol.writeSyncStep2(server, new Y.Doc());
    socket.fire("sync", encoding.toUint8Array(server));
    expect(provider.getSnapshot().rejection).toBeNull();
  });
});

describe("the editor's message about a refused write", () => {
  it("is a live alert that names what happened and what the user can do", async () => {
    const { socket, provider } = await connected();
    socket.fire("rejected", { event: "sync", reason: "document_full" });
    const html = renderToStaticMarkup(
      createElement(RejectionNotice, { snapshot: provider.getSnapshot(), onDismiss: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("This document is full");
    expect(html).toContain("Delete some content");
    expect(html).toContain("Dismiss");
    const status = renderToStaticMarkup(
      createElement(ConnectionStatus, { snapshot: provider.getSnapshot() }),
    );
    expect(status).toContain("Changes not saved");
    expect(status).toContain('data-state="rejected"');
    expect(status).not.toContain("Syncing");
  });

  it("renders nothing while nothing was refused", async () => {
    const { provider } = await connected();
    expect(
      renderToStaticMarkup(
        createElement(RejectionNotice, { snapshot: provider.getSnapshot(), onDismiss: () => {} }),
      ),
    ).toBe("");
  });

  it("has a distinct message with a next step for every reason", () => {
    const reasons = [
      "document_full",
      "too_large",
      "forbidden",
      "overloaded",
      "malformed",
      "unknown",
    ] as const;
    const titles = reasons.map((reason) => describeRejection(reason).title);
    expect(new Set(titles).size).toBe(5); // malformed and unknown share a message
    for (const reason of reasons)
      expect(describeRejection(reason).detail.length).toBeGreaterThan(40);
  });
});
