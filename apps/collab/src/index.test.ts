import { describe, expect, it } from "vitest";
import { can } from "@collabdocs/shared";
import { COLLAB_SERVER_STATUS } from "./index";

describe("collab workspace", () => {
  it("resolves the shared package", () => {
    expect(can("viewer", "write")).toBe(false);
    expect(COLLAB_SERVER_STATUS).toBe("not implemented");
  });
});
