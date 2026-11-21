#!/usr/bin/env node
// Prepares what the Lighthouse run needs: a verified user with a session, and a
// document that user owns. Run it against a started web app (and collab server).
//
// usage: node scripts/lighthouse/seed.mjs [out-file]
//
// Environment: WEB_URL (default http://localhost:3000) and MAIL_OUTBOX_DIR, the
// directory the web app's file mailer writes to (the verification mail is read
// from it). Writes { documentId, cookie: { name, value } } to out-file (default
// .lighthouseci-seed.json). The file holds a session cookie: it is git-ignored.
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const webUrl = process.env.WEB_URL ?? "http://localhost:3000";
const outbox = process.env.MAIL_OUTBOX_DIR;
const outFile = process.argv[2] ?? ".lighthouseci-seed.json";
if (!outbox) throw new Error("MAIL_OUTBOX_DIR is not set");

const email = `lighthouse-${randomUUID().slice(0, 8)}@example.test`;
const password = `pw-${randomUUID()}`;

async function call(route, init = {}) {
  const response = await fetch(new URL(route, webUrl), { redirect: "manual", ...init });
  return response;
}

function cookiesOf(response) {
  return response.headers.getSetCookie().map((line) => {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
  });
}

const jsonHeaders = { "content-type": "application/json" };

const registered = await call("/api/register", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ email, password, name: "Ada Lovelace" }),
});
if (registered.status !== 201) throw new Error(`register: ${registered.status}`);

let token;
for (const name of (await readdir(outbox)).sort().reverse()) {
  const mail = JSON.parse(await readFile(path.join(outbox, name), "utf8"));
  token = mail.to === email ? /verify-email\?token=([\w-]+)/.exec(mail.text)?.[1] : undefined;
  if (token) break;
}
if (!token) throw new Error("no verification mail");
const verified = await call("/api/verify-email", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ token }),
});
if (verified.status !== 200) throw new Error(`verify: ${verified.status}`);

// Sign in the way the sign-in form does: the CSRF token and its cookie, then the credentials.
const csrf = await call("/api/auth/csrf");
const { csrfToken } = await csrf.json();
const jar = new Map(cookiesOf(csrf).map((c) => [c.name, c.value]));
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
const signedIn = await call("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
  body: new URLSearchParams({ csrfToken, email, password, json: "true" }),
});
if (signedIn.status >= 400) throw new Error(`sign-in: ${signedIn.status}`);
for (const c of cookiesOf(signedIn)) jar.set(c.name, c.value);
const session = [...jar].find(([name]) => name.endsWith("session-token"));
if (!session) throw new Error("sign-in set no session cookie");

const created = await call("/api/documents", {
  method: "POST",
  headers: { ...jsonHeaders, cookie: cookieHeader() },
  body: JSON.stringify({ title: "Launch plan" }),
});
if (created.status !== 201) throw new Error(`create document: ${created.status}`);
const { document } = await created.json();

await writeFile(
  outFile,
  JSON.stringify({ documentId: document.id, cookie: { name: session[0], value: session[1] } }),
);
console.log(`seeded a verified user and document ${document.id}`);
