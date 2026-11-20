import { describe, expect, it } from "vitest";
import { MEMBERSHIP_MAX_AGE_MS, openMembershipChange, sealMembershipChange } from "./redis-auth";

const SECRET = "redis-message-secret-0123456789-abcdef";
const change = { documentId: "doc_1", userId: "user_1", change: "removed" } as const;

describe("sealed membership messages", () => {
  it("round-trips", () => {
    const now = 1_000_000;
    expect(openMembershipChange(sealMembershipChange(change, SECRET, now), SECRET, now)).toEqual(
      change,
    );
    expect(
      openMembershipChange(
        sealMembershipChange({ ...change, userId: null }, SECRET, now),
        SECRET,
        now,
      ),
    ).toEqual({ ...change, userId: null });
  });

  it("refuses another secret, an edited body and an unsealed message", () => {
    const now = 1_000_000;
    const sealed = sealMembershipChange(change, SECRET, now);
    expect(openMembershipChange(sealed, `${SECRET}-other`, now)).toBeNull();
    expect(openMembershipChange(sealed.replace("user_1", "user_2"), SECRET, now)).toBeNull();
    expect(openMembershipChange(JSON.stringify(change), SECRET, now)).toBeNull();
    expect(openMembershipChange("", SECRET, now)).toBeNull();
  });

  it("refuses a replay after the window and a message from the future", () => {
    const now = 1_000_000;
    const sealed = sealMembershipChange(change, SECRET, now);
    expect(openMembershipChange(sealed, SECRET, now + MEMBERSHIP_MAX_AGE_MS - 1)).toEqual(change);
    expect(openMembershipChange(sealed, SECRET, now + MEMBERSHIP_MAX_AGE_MS + 1)).toBeNull();
    expect(openMembershipChange(sealed, SECRET, now - 60_000)).toBeNull();
  });
});
