import { describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/register/route";

const MAX = 16 * 1024;

/** A registration whose JSON body is exactly `bytes` long: the extra field is padding. */
function registrationOfSize(bytes: number, padding = "x"): Request {
  const make = (pad: string) =>
    JSON.stringify({ email: "size@example.test", password: "a long enough passphrase", pad });
  const base = new TextEncoder().encode(make("")).length;
  const unit = new TextEncoder().encode(padding).length;
  const body = make(padding.repeat(Math.floor((bytes - base) / unit)));
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("the request body cap", () => {
  it("accepts a body of exactly 16 KiB and refuses one byte more", async () => {
    const ok = registrationOfSize(MAX);
    expect(new TextEncoder().encode(await ok.clone().text()).length).toBe(MAX);
    expect((await register(ok)).status).toBe(201);

    const over = registrationOfSize(MAX + 1);
    expect(new TextEncoder().encode(await over.clone().text()).length).toBe(MAX + 1);
    const response = await register(over);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("payload_too_large");
  });

  it("counts bytes, not characters", async () => {
    // 9000 two-byte characters are under 16384 characters and over 16384 bytes.
    const response = await register(registrationOfSize(MAX + 2000, "é"));
    expect(response.status).toBe(413);
  });

  it("refuses on the declared length without reading the body", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX + 1) },
      body: "{}",
    });
    expect((await register(request)).status).toBe(413);
  });

  it("stops reading a body that never ends", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
        if (pulled > 5000) controller.close();
      },
    });
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect((await register(request)).status).toBe(413);
    // The cap is 16 chunks of 1 KiB; the stream's own read-ahead adds a few.
    expect(pulled).toBeLessThan(40);
  });
});
