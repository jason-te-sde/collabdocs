import { describe, expect, it } from "vitest";
import { addressKey } from "./client-address";

describe("addressKey", () => {
  it("leaves an IPv4 address alone and unwraps an IPv4-mapped one", () => {
    expect(addressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("reduces an IPv6 address to its /64, however it is written", () => {
    expect(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2");
    expect(addressKey("2001:DB8:1:2::5")).toBe("2001:db8:1:2");
    expect(addressKey("2001:0db8:0001:0002:0:0:0:9")).toBe("2001:db8:1:2");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0");
    expect(addressKey("::1")).toBe("0:0:0:0");
  });

  it("gives two addresses of one /64 the same key and different /64s different keys", () => {
    expect(addressKey("2001:db8:1:2::1")).toBe(addressKey("2001:db8:1:2:ffff::2"));
    expect(addressKey("2001:db8:1:2::1")).not.toBe(addressKey("2001:db8:1:3::1"));
  });
});
