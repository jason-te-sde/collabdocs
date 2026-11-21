import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  ROLES,
  can,
  isAssignableRole,
  isRole,
  type Action,
  type Role,
} from "./permissions";

const EXPECTED: Record<Role, Action[]> = {
  owner: ["read", "write", "share", "delete", "change-role"],
  editor: ["read", "write", "share"],
  viewer: ["read"],
};

describe("can", () => {
  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const allowed = EXPECTED[role].includes(action);
      it(`${role} ${allowed ? "may" : "may not"} ${action}`, () => {
        expect(can(role, action)).toBe(allowed);
      });
    }
  }

  it("denies an unknown role and an unknown action", () => {
    expect(can("admin" as Role, "read")).toBe(false);
    expect(can("owner", "purge" as Action)).toBe(false);
  });

  it("denies inherited object keys used as a role", () => {
    expect(can("toString" as Role, "read")).toBe(false);
    expect(can("__proto__" as Role, "read")).toBe(false);
  });
});

describe("role guards", () => {
  it("recognises the three roles only", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it("never assigns the owner role", () => {
    expect(isAssignableRole("owner")).toBe(false);
    expect(isAssignableRole("editor")).toBe(true);
    expect(isAssignableRole("viewer")).toBe(true);
  });
});
