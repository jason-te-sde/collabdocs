import { describe, expect, it } from "vitest";
import { displayName, userColor, USER_COLORS } from "@/lib/collab/identity";
import { presentUsers } from "@/lib/collab/presence";

describe("userColor", () => {
  it("is stable for a user and always one of the palette's #rrggbb colours", () => {
    expect(userColor("user-1")).toBe(userColor("user-1"));
    for (const id of ["a", "b", "c", "user-1", "user-2", ""]) {
      expect(USER_COLORS).toContain(userColor(id));
    }
    expect(USER_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });

  it("spreads different users over the palette", () => {
    const colours = new Set(Array.from({ length: 40 }, (_, i) => userColor(`user-${i}`)));
    expect(colours.size).toBeGreaterThan(USER_COLORS.length / 2);
  });
});

describe("displayName", () => {
  it("prefers the name, falls back to the part of the email before the @", () => {
    expect(displayName({ name: "Ada Lovelace", email: "ada@example.test" })).toBe("Ada Lovelace");
    expect(displayName({ name: null, email: "ada@example.test" })).toBe("ada");
    expect(displayName({ name: "  ", email: "grace@example.test" })).toBe("grace");
  });
});

describe("presentUsers", () => {
  const states = new Map<number, Record<string, unknown>>([
    [1, { user: { id: "u-me", name: "Me", color: "#1d4ed8" } }],
    [2, { user: { id: "u-ada", name: "Ada", color: "#047857" } }],
    [3, { user: { id: "u-ada", name: "Ada", color: "#047857" } }],
    [4, { cursor: null }],
    [5, { user: { id: "u-bob", name: "Bob", color: "not a colour" } }],
  ]);

  it("lists each person once, the local user first, and skips states without a user", () => {
    const users = presentUsers(states, 1);
    expect(users.map((u) => u.name)).toEqual(["Me", "Ada", "Bob"]);
    expect(users[0]?.isSelf).toBe(true);
    expect(users.slice(1).every((u) => !u.isSelf)).toBe(true);
  });

  it("replaces a colour that is not #rrggbb", () => {
    const bob = presentUsers(states, 1).find((u) => u.id === "u-bob");
    expect(USER_COLORS).toContain(bob?.color);
  });
});
