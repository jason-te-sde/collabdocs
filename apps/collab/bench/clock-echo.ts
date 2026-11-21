// A process that only answers clock pings; used to test the skew measurement.
import { nowMs } from "./client";

process.on("message", (m: { type: string; id: number }) => {
  if (m.type === "ping") process.send!({ type: "pong", id: m.id, t: nowMs() });
});
process.send!({ type: "ready" });
