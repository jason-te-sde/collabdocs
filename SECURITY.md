# Security

## Reporting a vulnerability

Open a private security advisory on the repository's Security tab. Please do not file a public issue for a vulnerability. This is a portfolio project: there is no deployment and no bug bounty.

## The model

### Who you are

- **Sign-in.** GitHub OAuth, or an email and a password. Passwords are hashed with argon2id (19 MiB, 2 passes, 1 lane) and never stored or logged in plain text. The password check does the same work whether or not the email exists.
- **Sessions.** Auth.js JWT sessions in an `HttpOnly`, `SameSite=Lax` cookie, valid for 7 days. Every route looks the user up again, so a deleted user is refused at once.
- **Account linking.** A GitHub sign-in is not merged into a password account that has the same email: a GitHub email is not proof of owning the other account. Auth.js refuses that sign-in (`OAuthAccountNotLinked`). A test drives the real Auth.js flow, with GitHub's endpoints answered by a stand-in, to show that the refusal creates no session, no account link and no change to the password account.
- **Email verification.** A password account starts unverified: it can sign in, but an invitation sent to its address does not give it access (below). The registration mail carries a link to `/verify-email?token=...`; the page asks for a button press, which sends the token with `POST /api/verify-email`, so a mail scanner that opens the link does not use the token up. The token is 256 random bits, stored only as a SHA-256 hash, valid for 24 hours and for one use, and a new link replaces the older one. A GitHub account counts as verified when GitHub's `/user/emails` lists the address as verified at the time the account is first linked; otherwise it verifies like a password account. There is no password reset yet.
- **The mailer.** Mail goes through the `Mailer` interface in `apps/web/lib/mailer.ts`. `MAIL_TRANSPORT=console` prints messages (development; the default outside production), `file` writes them to `MAIL_OUTBOX_DIR` (tests, end-to-end tests). Neither delivers anything, and the console one puts verification links in the log, so in production the transport must be chosen on purpose: with `MAIL_TRANSPORT` unset and `NODE_ENV=production` the app refuses to send. To send real mail, implement `Mailer` for a provider (an HTTP API client or SMTP; `send` must throw when the provider refuses the message), add a case for it in `createMailer` that reads its settings from the environment, and set `MAIL_TRANSPORT` to its name. A failed send does not fail registration: the response says `verification: "failed"` and the banner in the app offers to send the link again.
- **Rate limits on accounts.** Sign-in (`/api/auth/callback/credentials` and the sign-in form's action), registration, confirming an address and requesting a new link are limited, in fixed windows, per client address and per account (the account key is a hash of the address). Defaults: sign-in 30 per 15 minutes per client address and 10 per 15 minutes per account; registration 10 per hour per client address and 3 per hour per account; a new link 3 per hour per account; confirming an address 30 per 15 minutes per client address (`AUTH_LIMIT_SIGNIN_PER_IP`, `AUTH_LIMIT_SIGNIN_PER_ACCOUNT`, `AUTH_LIMIT_REGISTER_PER_IP`, `AUTH_LIMIT_REGISTER_PER_ACCOUNT`, `AUTH_LIMIT_VERIFY_RESEND_PER_ACCOUNT`). Every attempt counts, successful or not, and a refused attempt still uses up the window; the answer is `429` with `Retry-After` and the code `rate_limited`. The counters are in Redis (one Lua script: increment and expiry together), so they hold across instances; without `REDIS_URL`, or while Redis does not answer within a second, they are kept in the process, which limits each instance on its own and never means no limit. The client address is the entry of `X-Forwarded-For` that the outermost trusted proxy added, counted from the end: `TRUSTED_PROXY_HOPS` (default 1). A client that writes its own `X-Forwarded-For` only adds entries in front of the proxy's, which are not read. With `TRUSTED_PROXY_HOPS=0`, or with no proxy header, all clients share the address "unknown", and the per-account limit is the one that protects. Running the app without a proxy that sets the header makes the per-address limits a single shared bucket: put a proxy in front.
- **CSRF.** State-changing routes need `Content-Type: application/json`, which a cross-site form cannot send, on top of the `SameSite=Lax` cookie.

### What you may do

Each member of a document has one role.

| Role   | read | write | share | delete | change-role |
| ------ | :--: | :---: | :---: | :----: | :---------: |
| owner  | yes  |  yes  |  yes  |  yes   |     yes     |
| editor | yes  |  yes  |  yes  |   no   |     no      |
| viewer | yes  |  no   |  no   |   no   |     no      |

- `packages/shared/src/permissions.ts` holds the table. `can(role, action)` is the only place that decides, and every REST route calls it, and so does the socket server for every event.
- A caller who is not a member gets **404**, the same answer as for a document that does not exist. A member who lacks the right gets **403**.
- A document has one owner, its creator. The owner role cannot be handed out, changed or removed, and ownership cannot be transferred in this version. The database enforces this, so a bug in a route cannot break it.
- Removing a member needs `change-role`. Any member except the owner may remove themselves.
- Inviting needs `share`, so an editor can invite, but only as editor or viewer.
- **An invitation grants access only to a verified address.** Otherwise anyone could register a stranger's address and receive what was meant for its owner. Inviting a registered, verified address creates the membership at once (201). Inviting a registered but unverified one stores a pending invitation (202): it grants nothing, and it becomes a membership, with the invited role, in the transaction that verifies the address. A pending invitation is listed with the members, can be withdrawn by anyone who may change roles (`DELETE /api/documents/:id/invitations/:inviteId`), is replaced by a later invitation to the same address, and is held by a table that refuses the owner role and an address that is not lower case.

### The collaboration token

The collab server cannot read the web app's session, so the web app hands out a token. It is an HS256 JWT signed with `COLLAB_TOKEN_SECRET` (at least 32 bytes, and different from `AUTH_SECRET`), with the document id, the user id and the role the user holds at that moment. It lives 5 minutes by default and at most 15. The verifier in `packages/shared` checks the signature (only HS256 is accepted), issuer, audience, expiry and that the token is for the document being opened.

A token cannot be revoked, so the collab server does not rely on it alone; see the next section.

### Sockets

The collab server ([docs/design/0003-collab-server.md](docs/design/0003-collab-server.md)) authenticates each socket once, at the handshake, and checks each event after that.

- **Handshake.** The client sends the token and the document id in the Socket.IO `auth` payload. The server verifies the signature, issuer, audience, expiry and that the token is for that document, then looks the membership up in the database. A bad, expired or foreign token, or a membership that no longer exists, is refused before any document is loaded. The refusal tells the client only a code (`invalid_token`, `not_a_member`, `too_many_connections`); the reason is logged.
- **The role a socket acts with** is the weaker of the token's role and the membership's current role. A token issued before a demotion cannot write.
- **Every event.** The rate limit is applied on arrival; then `can(role, action)` decides: `read` for sync step 1 and awareness, `write` for sync step 2 and updates. A viewer may sync, receive and send awareness (a cursor). Anything else from a viewer is rejected, logged (document, user, role, event; never content) and answered with a `rejected` notice, and the document does not change. Messages must be binary, within the size limit and well-formed, or they are rejected.
- **Withdrawing access.** When the web app removes a member, changes a role or deletes a document, it publishes a message on Redis, and every collab instance disconnects the affected sockets. If the message is lost, each loaded document compares its sockets with the `Membership` table every 60 seconds by default. A removed user cannot reconnect: the handshake looks the membership up again.
- **An open socket outlives its token.** The token is checked at the handshake only. Removal and role changes are what end a socket; a token that expires mid-session does not.
- **A write re-checks the role.** The socket's membership is read again when it finishes attaching, and before a write if it was last read more than a second ago, so a removed or demoted member stops writing within about a second, not at the next 60 s re-check. The periodic re-check closes a document's sockets when its query fails three times in a row, instead of only logging.
- **Awareness cannot be faked.** An awareness client id belongs to the user who first announced it, on any instance. A socket can set or remove only its own user's ids, at most eight of them, in messages of at most 8 KiB and sixteen states. A viewer cannot erase or impersonate another person's cursor.
- **Limits** bound what one client can do to the server. Per socket: 100 messages per second (burst 200) and 256 KiB per second (burst 2 MiB), either of which closes the socket. Per message: 1 MiB for a sync message, 8 KiB for awareness. Per document: 16 MiB stored (snapshot plus log; past it writes are refused with `document_full` and reads go on), 8 MiB of updates waiting for the database (past it the socket that would exceed it is closed), 250 sockets across all instances (counted atomically). The document cap is approximate: it can be passed by the updates in flight and, with several instances, by what the others append between two refreshes of the count. All are environment variables (README).
- **Redis integrity.** Every relay frame and membership message is signed with an HMAC-SHA256 under `REDIS_MESSAGE_SECRET` (at least 32 bytes, different from the token secret, the same in the web app and every collab server; required with `REDIS_URL`). A message without a valid tag is ignored and logged, and a membership message older than two minutes is ignored, which bounds a replay. So access to Redis alone cannot inject an update, forge a role change or disconnect a user.
- **Redis trust model, what is left.** Someone with access to Redis but not the secret can still: read document content and presence from the relay channel (updates are not encrypted); drop, delay or replay messages (a lost relay message is repaired by reading the log, a lost membership message by the re-checks, a replayed relay frame is a no-op in Yjs, a replayed membership message works for two minutes and costs a reconnect); and write the connection counters, which can refuse new sockets for a document until the entries expire (45 s) or admit more than the limit. Keep Redis on a private network, give it a password and TLS where it is shared, and treat `REDIS_MESSAGE_SECRET` like `COLLAB_TOKEN_SECRET`: anyone who has it can forge membership messages. When Redis is unreachable the collab server keeps serving its open sockets and refuses new ones; at start it refuses to run.
- **The collab server's secret** is the same `COLLAB_TOKEN_SECRET`; anyone with it can mint a token for any document and role that the membership check allows.

## Known limits of this version

- **Rate limiting covers the account routes, not the rest of the REST API.** The document and membership routes need a session and a role; they are not limited per client.
- **A per-account limit can be used to slow someone down.** Ten wrong passwords for an address within 15 minutes make further sign-in attempts for it, correct or not, wait for the window to end. That is the price of a limit that holds against a guesser who rotates addresses; a CAPTCHA or an escalating delay would soften it.
- **Counters fall back to the process when Redis is unreachable,** so the limits hold per instance, not per cluster, for that time.
- **Email enumeration.** Registration says when an email is taken, and an invitation says when no user has the email or the account has not verified it. Both need either a session with the right role or are inherent to open registration; the rate limits slow enumeration but do not stop it.
- **No password reset.** A user who forgets the password has no way back in, and an address that cannot receive the verification mail cannot be verified.
- **Invitations need an account.** An address with no account gets a 404; the invitation is not stored for a person who registers later.
- **The mailer in this repository does not deliver mail.** See "The mailer" above.
- **An open socket outlives its token** and is ended only by removal, role change or the checks above.
- **Secrets** come from the environment. None is committed; `.env` files are ignored.
