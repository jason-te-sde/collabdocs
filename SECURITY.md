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

- `packages/shared/src/permissions.ts` holds the table. `can(role, action)` is the only place that decides, and every REST route calls it. The socket server will call it for every event.
- A caller who is not a member gets **404**, the same answer as for a document that does not exist. A member who lacks the right gets **403**.
- A document has one owner, its creator. The owner role cannot be handed out, changed or removed, and ownership cannot be transferred in this version. The database enforces this, so a bug in a route cannot break it.
- Removing a member needs `change-role`. Any member except the owner may remove themselves.
- Inviting needs `share`, so an editor can invite, but only as editor or viewer.

### The collaboration token

The collab server cannot read the web app's session, so the web app hands out a token. It is an HS256 JWT signed with `COLLAB_TOKEN_SECRET` (at least 32 bytes, and different from `AUTH_SECRET`), with the document id, the user id and the role the user holds at that moment. It lives 5 minutes by default and at most 15. The verifier in `packages/shared` checks the signature (only HS256 is accepted), issuer, audience, expiry and that the token is for the document being opened.

A token cannot be revoked, so a removed or demoted member keeps the old rights until it expires. The collab server will therefore disconnect live connections when a membership changes, and re-check the role on every write.

## Known limits of this version

- **No rate limiting.** Registration and sign-in can be tried as often as a client likes. Rate limits arrive with the collab server, which brings Redis into use.
- **Email enumeration.** Registration says when an email is taken, and an invitation says when no user has the email. Both need either a session with the right role or are inherent to open registration.
- **No email verification and no password reset.** Anyone can register any address, so an email is a label, not proof of identity, until verification is added.
- **Only registered users can be invited.** There are no pending invitations.
- **Secrets** come from the environment. None is committed; `.env` files are ignored.
