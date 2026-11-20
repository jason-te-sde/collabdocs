import { describe, expect, it } from "vitest";
import { decodeRelay, encodeRelay } from "../src/relay";

const SECRET = "relay-secret-0123456789-abcdefghijklmnop";

describe("relay frame", () => {
  it("round-trips binary data with a fixed overhead", () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
    const frame = encodeRelay({ from: "i1", documentId: "doc_1", kind: "update", data }, SECRET);
    expect(frame.byteLength).toBeLessThan(data.byteLength + 64);
    expect(decodeRelay(frame, SECRET)).toEqual({
      from: "i1",
      documentId: "doc_1",
      kind: "update",
      data,
    });
    const awareness = encodeRelay(
      { from: "i2", documentId: "d", kind: "awareness", data: new Uint8Array() },
      SECRET,
    );
    expect(decodeRelay(awareness, SECRET)?.kind).toBe("awareness");
    expect(decodeRelay(awareness, SECRET)?.userId).toBeUndefined();
    const owned = encodeRelay(
      { from: "i2", documentId: "d", kind: "awareness", data: new Uint8Array(), userId: "user_1" },
      SECRET,
    );
    expect(decodeRelay(owned, SECRET)?.userId).toBe("user_1");
  });

  it("rejects frames that are not well formed", () => {
    expect(decodeRelay(new Uint8Array(), SECRET)).toBeNull();
    expect(decodeRelay(Uint8Array.from([9, 1, 2, 3]), SECRET)).toBeNull();
    expect(decodeRelay(new Uint8Array(100), SECRET)).toBeNull();
  });

  it("rejects a frame signed with another secret, or altered after signing", () => {
    const message = { from: "i1", documentId: "doc_1", kind: "update", data: Uint8Array.of(1, 2) };
    const frame = encodeRelay({ ...message, kind: "update" as const }, SECRET);
    expect(decodeRelay(frame, `${SECRET}-other`)).toBeNull();
    const altered = Uint8Array.from(frame);
    altered[altered.length - 40] = (altered[altered.length - 40]! + 1) % 256;
    expect(decodeRelay(altered, SECRET)).toBeNull();
    // Without the tag, a body alone is not enough.
    expect(decodeRelay(frame.subarray(0, frame.length - 32), SECRET)).toBeNull();
  });
});
