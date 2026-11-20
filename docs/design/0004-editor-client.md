# 0004. The editor client

Status: accepted.

## Context

The editor must show other people's cursors and edits live, keep working when the network does not, and never let a viewer change the document. The collab server's contract is [0003](0003-collab-server.md); this record is the browser side of it.

## Decisions

**TipTap with its Yjs extensions.** TipTap 3 binds ProseMirror to a `Y.Doc` through `@tiptap/extension-collaboration` and draws remote cursors with `@tiptap/extension-collaboration-caret`. Both build on `@tiptap/y-tiptap`, TipTap's maintained fork of `y-prosemirror`, so the project uses that and not `y-prosemirror` itself. The StarterKit's own undo is turned off: the collaboration extension's undo reverts only the local user's changes, where the history extension would revert everyone's.

**A provider of our own (`lib/collab/provider.ts`), not `y-websocket`.** The server speaks y-protocols over two Socket.IO events without y-websocket's framing, so the provider is one file of plain TypeScript with no React in it: it takes a `Y.Doc`, a function that fetches a token and a socket factory, and exposes an immutable snapshot for `useSyncExternalStore`. That keeps it testable with a fake socket and the real wiring covered by the end-to-end tests.

**Reconnection is ours, not Socket.IO's.** Socket.IO does not retry a handshake that a middleware refused, and its automatic retries would reuse the first token, which expires after five minutes. The socket is created with `reconnection: false`; the provider fetches a token, connects, and on any loss schedules the next attempt itself, with exponential backoff (500 ms doubling to 8 s) and jitter. A `revoked` notice skips the backoff: the token endpoint then decides. 404 and 403 mean the user has no access (the page says so and stops), 401 means signed out, anything else is retried. A role change therefore takes effect in the open page: the server closes the socket, the new token carries the new role, and the editor toggles `editable`.

**The browser going offline closes the socket.** Chromium keeps an established WebSocket open when the page goes offline, so waiting for the transport to notice would leave the page claiming to be connected. The provider listens to the window's `online` and `offline` events, disconnects at once on `offline` and reconnects on `online`.

**Offline edits stay in the `Y.Doc`.** Nothing is cleared on a disconnect except the remote cursors. The handshake of the next connection does the work: the client sends step 1; the server answers with step 2 and, for a role that may write, sends its own step 1, which the client answers with a step 2 carrying everything the server lacks. Yjs merges per character, so concurrent offline and online edits all survive. `unsynced` is true from the first local change made while no handshake has completed until that last step 2 is sent; the server does not acknowledge updates, so this is the earliest honest moment.

**A viewer sends nothing.** The editor is not editable, and the provider independently refuses to send updates and refuses to answer a step 1 (a step 2 is a write, and the server rejects it). The server never sends a viewer a step 1; the check is for a server that has changed.

**Awareness after a reconnect.** When a socket closes, the server removes that client's awareness state and bumps its clock by one. y-protocols ignores an update whose clock is not higher than the one held, so a reconnecting client that has not moved its cursor would stay invisible. The provider bumps its own clock twice on connect before announcing itself. Remote states are dropped locally when the connection goes down, so cursors of people who may have left do not linger.

**Local copies per user.** y-indexeddb stores the document under `collabdocs:<userId>:<documentId>`, so two accounts on one browser never read each other's copy, and the copy is deleted when the server says the user has no access. IndexedDB is the only place a removed member's text could remain on the device.

**The collab server's address is read at render time** (`COLLAB_URL`), not baked in at build time, so a single build serves every deployment.

## Accessibility

Every control has a visible label or an accessible name; the dialogs are Radix `Dialog` (focus trap, Escape, focus return, title and description); the connection indicator is a polite live region; the editor is a labelled multi-line textbox; the page has a skip link, landmarks and one `h1`; focus rings are visible; text and controls use colours that meet WCAG AA contrast on their backgrounds, and cursor labels use colours dark enough for white text. J-T5 measures this with Lighthouse.

## Consequences

- The provider and the presence model are unit tested without a browser; the contract with the real server is tested end to end.
- A second tab of the same user is a second client: it has its own cursor, and the presence list shows the person once.
- The client has no fallback transport: WebSocket only, so a proxy that blocks WebSockets blocks editing. Long polling would need sticky sessions behind a load balancer.

## Alternatives rejected

- **`y-websocket`'s client with a custom server shim.** See 0001.
- **Socket.IO's own reconnection with `auth` as a function.** It would refresh the token, but it does not retry a refused handshake and gives no place to stop on "not a member".
- **A service worker for offline loading.** Out of scope: an offline reload of a page that was never loaded is not offered; a reload while the server is unreachable keeps its edits.
