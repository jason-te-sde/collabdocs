import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const created: Array<{ url: string; options: Record<string, unknown> }> = [];

vi.mock("socket.io-client", () => ({
  io: (url: string, options: Record<string, unknown>) => {
    created.push({ url, options });
    return {
      connected: false,
      auth: {},
      connect: () => {},
      disconnect: () => {},
      on: () => {},
      emit: () => {},
    };
  },
}));

describe("the collab provider's own socket", () => {
  it("asks for the WebSocket transport only, so it never tries long polling, which the server refuses", async () => {
    const { CollabProvider } = await import("@/lib/collab/provider");
    const provider = new CollabProvider({
      documentId: "doc_1",
      doc: new Y.Doc(),
      url: "http://collab.test",
      fetchToken,
      network: { isOnline: () => true, subscribe: () => () => {} },
    });
    provider.destroy();
    expect(created).toHaveLength(1);
    expect(created[0]!.options.transports).toEqual(["websocket"]);
  });
});

async function fetchToken() {
  return { token: "t", role: "viewer" as const };
}
