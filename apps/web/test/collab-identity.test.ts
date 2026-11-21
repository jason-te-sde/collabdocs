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

describe("presentUsers and a state that claims another person's user id", () => {
  // The collab server refuses such a state (it checks `user.id` against the token), so none
  // reaches the page from an honest server. These tests pin what the list does with one anyway:
  // an id is one row, whoever claims it, and the local user's row cannot be displaced.
  const me = { user: { id: "u-me", name: "Me", color: "#1d4ed8" } };
  const mallory = { user: { id: "u-me", name: "Mallory", color: "#b91c1c" } };

  it("keeps the local user's own row when another client claims the same id, in either order", () => {
    for (const order of [
      [
        [9, mallory],
        [1, me],
      ],
      [
        [1, me],
        [9, mallory],
      ],
    ] as const) {
      const users = presentUsers(new Map(order), 1);
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ id: "u-me", name: "Me", isSelf: true });
    }
  });

  it("adds no row for a state whose user id is not a string", () => {
    const users = presentUsers(
      new Map<number, Record<string, unknown>>([
        [1, me],
        [2, { user: { id: 7, name: "Seven" } }],
        [3, { user: { id: { toString: "x" }, name: "Object" } }],
        [4, { user: null }],
        [5, { user: "u-me" }],
      ]),
      1,
    );
    expect(users.map((u) => u.name)).toEqual(["Me"]);
  });
});

describe("presentUsers and another member's row", () => {
  const ada = { user: { id: "u-ada", name: "Ada", color: "#047857" } };

  it("is not changed by a state that carries a different user id, whatever name or colour it claims", () => {
    // Client 3 is signed in as u-mallory and announces itself with Ada's name and colour.
    const mallory = { user: { id: "u-mallory", name: "Ada", color: "#047857" } };
    for (const order of [
      [
        [2, ada],
        [3, mallory],
      ],
      [
        [3, mallory],
        [2, ada],
      ],
    ] as const) {
      const users = presentUsers(new Map(order), 1);
      expect(users).toHaveLength(2);
      expect(users.find((u) => u.id === "u-ada")).toEqual({
        id: "u-ada",
        name: "Ada",
        color: "#047857",
        isSelf: false,
      });
      // The other state is its own row, under its own id.
      expect(users.find((u) => u.id === "u-mallory")).toMatchObject({ isSelf: false });
    }
  });

  it("is one row per id, the first one seen: the page cannot tell which client an id belongs to", () => {
    // Two clients claiming u-ada is something only the collab server can rule out (it checks
    // the id against the token, and writes the name itself). The page keeps the first and
    // shows a single row, so a duplicate claim never adds a second person to the list.
    const duplicate = { user: { id: "u-ada", name: "Someone else", color: "#b91c1c" } };
    const users = presentUsers(
      new Map<number, Record<string, unknown>>([
        [2, ada],
        [3, duplicate],
      ]),
      1,
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: "u-ada", name: "Ada" });
  });
});
