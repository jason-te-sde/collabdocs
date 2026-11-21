/**
 * One load-generator process: a share of the editors of a run. The orchestrator
 * (run.ts) forks it with a WorkerConfig and talks to it over IPC.
 *
 *   worker -> parent  { type: "ready" }                  all editors connected and synced
 *   parent -> worker  { type: "go", from, to }           start; measure edits sent in [from, to)
 *   parent -> worker  { type: "collect" }                after the drain
 *   worker -> parent  { type: "result", ... }
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { LoadEditor, Rows, nowMs } from "./client";
import { LagMeter, type Lag } from "./lag";

export interface WorkerConfig {
  workerIndex: number;
  url: string;
  documentId: string;
  /** Editors of this worker: their global index, user id, token and whether they write. */
  editors: Array<{ index: number; userId: string; token: string; writer: boolean }>;
  typingIntervalMs: number;
  readerCursorIntervalMs: number;
  /** A folder for the binary logs, which the parent reads. */
  outDir: string;
  /** Editors opened at once while connecting. */
  connectBatch: number;
}

export interface WorkerResult {
  workerIndex: number;
  sendsFile: string;
  receivesFile: string;
  disconnects: number;
  rejections: number;
  connectErrors: string[];
  /** Per editor: a hash of its final text. */
  finals: Array<{ index: number; length: number; hash: string }>;
  lag: Lag;
  cpuMs: { user: number; system: number };
  windowMs: number;
  /** Messages the editors received from the server inside the window. */
  messages: { sync: number; awareness: number };
}

const config = JSON.parse(process.env.BENCH_WORKER ?? "null") as WorkerConfig | null;
if (!config) throw new Error("BENCH_WORKER is not set");

const sends = new Rows(3);
const receives = new Rows(4, 1 << 16);
const editors = config.editors.map(
  (e) =>
    new LoadEditor({
      index: e.index,
      userId: e.userId,
      url: config.url,
      token: e.token,
      documentId: config.documentId,
      writer: e.writer,
      typingIntervalMs: config.typingIntervalMs,
      readerCursorIntervalMs: config.readerCursorIntervalMs,
      sends,
      receives,
    }),
);

const meter = new LagMeter(5);
let lag: Lag = { p50: 0, p99: 0, max: 0, mean: 0, maxAtMs: 0, samples: 0 };
let cpuStart = process.cpuUsage();
let cpu = { user: 0, system: 0 };
let windowMs = 0;
const total = () => ({
  sync: editors.reduce((n, e) => n + e.received.sync, 0),
  awareness: editors.reduce((n, e) => n + e.received.awareness, 0),
});
let messagesAtStart = { sync: 0, awareness: 0 };
let messages = { sync: 0, awareness: 0 };

async function connectAll(): Promise<void> {
  for (let i = 0; i < editors.length; i += config!.connectBatch) {
    await Promise.all(editors.slice(i, i + config!.connectBatch).map((editor) => editor.connect()));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function at(time: number, action: () => void): void {
  setTimeout(action, Math.max(0, time - nowMs()));
}

process.on("message", (message: { type: string; from?: number; to?: number; id?: number }) => {
  if (message.type === "ping") {
    process.send!({ type: "pong", id: message.id, t: nowMs() });
    return;
  }
  if (message.type === "go") {
    const from = message.from!;
    const to = message.to!;
    // Recording and typing begin together, at once; the first stretch is warm-up.
    for (const editor of editors) {
      editor.recording = true;
      editor.start();
    }
    at(from, () => {
      meter.start();
      cpuStart = process.cpuUsage();
      messagesAtStart = total();
    });
    at(to, () => {
      lag = meter.stop();
      const used = process.cpuUsage(cpuStart);
      cpu = { user: used.user / 1000, system: used.system / 1000 };
      windowMs = to - from;
      const end = total();
      messages = {
        sync: end.sync - messagesAtStart.sync,
        awareness: end.awareness - messagesAtStart.awareness,
      };
      for (const editor of editors) editor.stop();
    });
  } else if (message.type === "collect") {
    const sendsFile = path.join(config!.outDir, `sends-${config!.workerIndex}.bin`);
    const receivesFile = path.join(config!.outDir, `receives-${config!.workerIndex}.bin`);
    const sendsData = sends.toArray();
    const receivesData = receives.toArray();
    writeFileSync(
      sendsFile,
      Buffer.from(sendsData.buffer, sendsData.byteOffset, sendsData.byteLength),
    );
    writeFileSync(
      receivesFile,
      Buffer.from(receivesData.buffer, receivesData.byteOffset, receivesData.byteLength),
    );
    const result: WorkerResult = {
      workerIndex: config!.workerIndex,
      sendsFile,
      receivesFile,
      disconnects: editors.reduce((n, e) => n + e.disconnects, 0),
      rejections: editors.reduce((n, e) => n + e.rejections, 0),
      connectErrors: editors.flatMap((e) => e.connectErrors),
      finals: editors.map((e, i) => {
        const text = e.text.toString();
        return {
          index: config!.editors[i]!.index,
          length: text.length,
          hash: createHash("sha1").update(text).digest("hex"),
        };
      }),
      lag,
      cpuMs: cpu,
      windowMs,
      messages,
    };
    process.send!({ type: "result", result });
  } else if (message.type === "exit") {
    for (const editor of editors) editor.close();
    process.exit(0);
  }
});

connectAll().then(
  () => process.send!({ type: "ready" }),
  (error: unknown) => {
    process.send!({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  },
);
