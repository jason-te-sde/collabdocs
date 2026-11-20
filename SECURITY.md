# Security

## Reporting a vulnerability

Open a private security advisory on the repository's Security tab. Please do not file a public issue for a vulnerability. This is a portfolio project: there is no deployment and no bug bounty.

## The model

### Who you are

- **Sign-in.** GitHub OAuth, or an email and a password. Passwords are hashed with argon2id (19 MiB, 2 passes, 1 lane) and never stored or logged in plain text. The password check does the same work whether or not the email exists.
- **Sessions.** Auth.js JWT sessions in an `HttpOnly`, `SameSite=Lax` cookie, valid for 7 days. Every route looks the user up again, so a deleted user is refused at once.
- **Account linking.** A GitHub sign-in is not merged into a password account that has the same email: a GitHub email is not proof of owning the other account. Auth.js refuses that sign-in.
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
- **Limits** on update size, messages per second per socket and sockets per document bound what one client can do to the server.
- **Redis is trusted.** Anyone who can publish on the relay channel can inject Yjs updates into the instances' copies, and on the membership channel can disconnect users. Keep Redis on a private network and give it a password where it is shared. The relay does not carry roles, so it cannot be used to widen anyone's rights; it can write to documents.
- **The collab server's secret** is the same `COLLAB_TOKEN_SECRET`; anyone with it can mint a token for any document and role that the membership check allows.

## Known limits of this version

- **No rate limiting on the REST API.** Registration and sign-in can be tried as often as a client likes. The collab server limits its sockets, but the web app's routes are not limited yet.
- **Email enumeration.** Registration says when an email is taken, and an invitation says when no user has the email. Both need either a session with the right role or are inherent to open registration.
- **No email verification and no password reset.** Anyone can register any address, so an email is a label, not proof of identity, until verification is added.
- **Only registered users can be invited.** There are no pending invitations.
- **Secrets** come from the environment. None is committed; `.env` files are ignored.
