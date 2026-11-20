import { describe, expect, it } from "vitest";
import { decodeRelay, encodeRelay } from "../src/relay";

describe("relay frame", () => {
  it("round-trips binary data without inflating it", () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
    const frame = encodeRelay({ from: "i1", documentId: "doc_1", kind: "update", data });
    expect(frame.byteLength).toBeLessThan(data.byteLength + 32);
    expect(decodeRelay(frame)).toEqual({ from: "i1", documentId: "doc_1", kind: "update", data });
    const awareness = encodeRelay({
      from: "i2",
      documentId: "d",
      kind: "awareness",
      data: new Uint8Array(),
    });
    expect(decodeRelay(awareness)?.kind).toBe("awareness");
    expect(decodeRelay(awareness)?.userId).toBeUndefined();
    const owned = encodeRelay({
      from: "i2",
      documentId: "d",
      kind: "awareness",
      data: new Uint8Array(),
      userId: "user_1",
    });
    expect(decodeRelay(owned)?.userId).toBe("user_1");
  });

  it("rejects frames that are not well formed", () => {
    expect(decodeRelay(new Uint8Array())).toBeNull();
    expect(decodeRelay(Uint8Array.from([9, 1, 2, 3]))).toBeNull();
    expect(decodeRelay(Uint8Array.from([0, 200]))).toBeNull();
  });
});
