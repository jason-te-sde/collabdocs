import net from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TestClient,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  launch,
  redisUrl,
  resetDb,
  settle,
  storedText,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(async () => {
  await cleanup();
  for (const proxy of proxies.splice(0)) await proxy.stop();
});
afterAll(closeDb);

const proxies: RedisProxy[] = [];

/** A TCP relay in front of the real Redis that a test can cut and restore. */
class RedisProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  port = 0;

  static async start(): Promise<RedisProxy> {
    const proxy = new RedisProxy();
    proxies.push(proxy);
    await proxy.listen(0);
    return proxy;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  private listen(port: number): Promise<void> {
    const target = new URL(redisUrl());
    const server = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 6379), target.hostname);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => {
          this.sockets.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server = server;
    return new Promise((resolve) =>
      server.listen(port, "127.0.0.1", () => {
        this.port = (server.address() as net.AddressInfo).port;
        resolve();
      }),
    );
  }

  /** Redis becomes unreachable: open connections drop and new ones are refused. */
  async cut(): Promise<void> {
    await this.stop();
  }

  async restore(): Promise<void> {
    await this.listen(this.port);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Redis at start", () => {
  it("rejects after the connect timeout when nothing listens", async () => {
    const started = Date.now();
    await expect(
      launch({ redisUrl: "redis://127.0.0.1:1", redisConnectTimeoutMs: 500 }),
    ).rejects.toThrow(/Redis/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects after the connect timeout when Redis accepts and never answers", async () => {
    const sockets: net.Socket[] = [];
    const blackhole = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", () => resolve()));
    const port = (blackhole.address() as net.AddressInfo).port;
    try {
      const started = Date.now();
      await expect(
        launch({ redisUrl: `redis://127.0.0.1:${port}`, redisConnectTimeoutMs: 500 }),
      ).rejects.toThrow(/Redis/);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  });
});

describe("Redis going away at run time", () => {
  it("keeps open sockets working, refuses new handshakes promptly and recovers", async () => {
    const proxy = await RedisProxy.start();
    const server = await launch({ redisUrl: proxy.url });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");

    await proxy.cut();
    await settle(300);

    // The sockets that are open keep editing, and the edit is stored.
    a.insert(0, "still here");
    await waitFor(() => b.text === "still here", "the edit to reach the other socket");
    await waitFor(async () => (await storedText(f.documentId)) === "still here", "the log");
    expect(a.connected && b.connected).toBe(true);

    // A new handshake is refused at once, not after a timeout.
    const started = Date.now();
    const refused = await connectErrorOf(server, f, "viewer", "viewer");
    expect(refused.code).toBe("server_error");
    expect(Date.now() - started).toBeLessThan(1000);

    // When Redis is back, handshakes work again.
    await proxy.restore();
    await waitFor(
      async () => {
        const probe = await TestClient.connect(server, f, "viewer", "viewer", { noWait: true });
        await settle(400);
        const ok = probe.connected;
        probe.close();
        return ok;
      },
      "handshakes to work again",
      15_000,
    );
  });
});
