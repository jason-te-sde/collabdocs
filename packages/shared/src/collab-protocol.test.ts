import { describe, expect, it } from "vitest";
import { encodeMembershipChange, parseMembershipChange } from "./collab-protocol";

describe("membership change message", () => {
  it("round-trips", () => {
    const change = { documentId: "d1", userId: "u1", change: "removed" } as const;
    expect(parseMembershipChange(encodeMembershipChange(change))).toEqual(change);
    const all = { documentId: "d1", userId: null, change: "document-deleted" } as const;
    expect(parseMembershipChange(encodeMembershipChange(all))).toEqual(all);
  });

  it("rejects anything that is not a well-formed change", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"documentId":"","userId":"u","change":"removed"}',
      '{"documentId":"d","userId":3,"change":"removed"}',
      '{"documentId":"d","userId":"u","change":"promoted"}',
      '{"userId":"u","change":"removed"}',
    ]) {
      expect(parseMembershipChange(raw), raw).toBeNull();
    }
  });
});
