# Benchmarks

This page defines what the README's Performance numbers mean, how they are measured and when a measurement is thrown away. The protocol below was committed before the first measured run. If it has to change after numbers have been seen, the change is recorded in [Changes to the protocol](#changes-to-the-protocol) with its reason, and the earlier results stay in the repository.

## The claim

> Sync latency under 100 ms.

means: **with 50 editors on one document on local loopback, the 95th percentile of the sync latency is below 100 ms.**

- **One sample** is one edit as seen by one other editor: the time from the moment the writing client has applied its change to its own `Y.Doc` and is about to send it, to the moment the receiving client has received it and applied it to its own `Y.Doc`. An edit seen by 49 other editors gives 49 samples.
- **The statistic** is the 95th percentile (nearest rank: the value at rank `ceil(0.95 n)` of the sorted samples) of all the samples of a run.
- **The claim holds** if at least three valid runs at 50 editors were made and the p95 of every one of them is below 100 ms. Not the median of the runs: all of them.
- A failed run at 50 editors (see [An invalid run, and a failed one](#an-invalid-run-and-a-failed-one)) counts as one of the three, and a claim with a failed run is not supported as measured.
- The p50 and p99, and the same numbers at 100 and 200 editors, are reported too. They are not part of the claim.
- **Loopback** means the clients and the server run on one machine and talk over `127.0.0.1`. No network latency is included. The number is the cost of the server and the protocol, not of anyone's connection.

The second goal ("50 or more people editing one document at once, with live cursors and presence") is supported by the same runs: they have 50, 100 and 200 editors connected to one document, with cursors and presence on, and the run is valid only if every one of them stayed connected, was never refused and ended with the same document.

## Protocol

### What is under test

- **The real server**, started as a separate process for every run, with a new document and new users: `NODE_ENV=production node --import tsx src/main.ts` in `apps/collab`. This is what `npm run start -w apps/collab` runs, without the wrapper processes, so that the process whose memory and CPU are recorded is the server itself. The collab server has no compile step in this repository (`tsx` runs the TypeScript, and the Lighthouse job in CI starts it the same way), so "production build" here means production mode of the code as it ships.
- **Redis on** (`REDIS_URL` set: the relay between instances, the connection counters and the membership channel are live, with one instance), **PostgreSQL persistence on** (every accepted update is appended to the log and the log is compacted into snapshots, with the default `COLLAB_COMPACT_EVERY_UPDATES` of 200 and `COLLAB_COMPACT_AFTER_MS` of 30 seconds).
- **Default limits.** No `COLLAB_*` variable is passed to the server, so every limit has its default (see the README). If a default limit disconnects or refuses part of the load, that is a finding and is reported as such; no limit is raised silently. The load was designed to fit under the defaults: every editor is a different user (the per-user limits are 8 sockets and 1 handshake per second), and a writer sends about 6 messages and a few hundred bytes per second against 100 messages and 256 KiB per second per socket.
- One server instance, one document, one process for PostgreSQL 17 and one for Redis, all on the same machine, started before the run and left alone.

### The editors

A load-generator editor is a `Y.Doc` and a y-protocols `Awareness`, built from `yjs` and `socket.io-client`, speaking the server's real protocol: a signed collaboration token in the handshake, sync step 1 on connect, sync step 2 in answer to the server's step 1, one `sync` update per local change, and `awareness` updates. It is the same message flow as the browser editor's provider (`apps/web/lib/collab/provider.ts`) and as the test client in `apps/collab/test/support.ts`; it has no editor view.

| Parameter               | Value                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editors per run         | 50, 100 and 200, all with the role `editor` (one of them is the owner)                                                                                                                               |
| Writers                 | 20% of the editors (every fifth one): 10, 20 and 40. The others only read                                                                                                                            |
| Typing rate of a writer | 3 edits per second on average, one character per edit. The time to the next edit is uniform between 0.5 and 1.5 times 333 ms. A writer types without pause for the whole run, which is a fast typist |
| Where a writer types    | At its own cursor, which starts at a random place in the text and moves forward with every character                                                                                                 |
| Awareness of a writer   | Its cursor (a Yjs relative position, as the editor sends) is updated with every character                                                                                                            |
| Awareness of a reader   | Its cursor moves to a random place every 5 seconds on average (uniform between 2.5 and 7.5)                                                                                                          |
| Awareness of everyone   | A name and a colour at connect, and the 15-second renewal that `y-protocols` runs by itself                                                                                                          |
| Total edit rate         | 30, 60 and 120 edits per second, each delivered to 49, 99 and 199 other editors                                                                                                                      |
| Warm-up                 | 10 seconds with everything switched on, not sampled                                                                                                                                                  |
| Measured window         | 60 seconds. A sample counts if its edit was sent inside the window                                                                                                                                   |
| Drain                   | 5 seconds after the window, during which the writers have stopped and the editors keep receiving. Whatever has not arrived after the drain is counted as missing                                     |
| Runs per size           | 3 valid runs, made in rounds (50, 100, 200, 50, 100, 200, 50, 100, 200), each with a fresh server, document and users                                                                                |
| Connecting              | 10 editors at a time, 50 ms apart. A run starts when every editor has received the server's state                                                                                                    |

The document starts empty and grows by at most about 8,400 characters in a run (200 editors, warm-up included), so these runs measure a small document. A large document is not measured.

### The load generator

The editors are spread over several processes, at most 40 editors per process (50 editors: 2 processes, 100: 3, 200: 5), with the writers spread evenly. Every process records the delay of its own event loop (`monitorEventLoopDelay`, 5 ms resolution, with the resolution subtracted; about a millisecond of timer slop is left in, so the figure slightly overstates the lag) and its CPU use during the measured window.

**Clocks.** The processes timestamp with `performance.timeOrigin + performance.now()`, which is wall-clock time with sub-millisecond resolution and is the same clock in every process of the machine. A negative latency would show a disagreement and makes the run invalid.

**Matching an edit to its receipt.** Every editor has a fixed Yjs client id. A writer's edit is identified by the writer's client id and its Yjs clock after the edit. A receiver looks at each remote transaction (`afterTransaction`, origin the server) and records, for every client whose clock advanced, the client id, the new clock and the time. The orchestrator joins the two logs after the run. This adds no data to the document and no work to the wire.

### What is recorded

The server's resident memory and cumulative CPU time are read with `ps` once a second. The results give, for the measured window, the highest resident memory, the resident memory at the end, the mean CPU use as a percentage of one core, and the highest one-second CPU use. The load average (1, 5 and 15 minutes) is read when the run starts.

Each run writes one JSON file in `apps/collab/bench/results/` with the commit, whether the working tree was dirty (anything outside the results folder that differs from the commit), the Node version, the machine (`sysctl -n machdep.cpu.brand_string`, core count, RAM), the load average, every parameter above, the latency summary and histogram, the delivery counts, the server's memory and CPU, each generator process's event-loop delay and CPU, the integrity counts and the verdict. Paths in the files are relative to the repository root.

### A quiet machine

Before a measured run the machine must be quiet: the second sample of `top -l 2` shows at least 70% idle CPU and no process busier than 20% of a core. The orchestrator checks this itself, waits and checks again every 15 seconds for up to 20 minutes, and records what it saw; if the machine is not quiet by then the run does not start. Two measured runs never overlap. The check is made after the previous run has been cleaned up, immediately before the new run starts.

### An invalid run, and a failed one

A run is **invalid** when it says nothing about the server. It is kept in the results folder, marked, and made again (it does not count towards the three):

- a generator process's event-loop delay, 99th percentile over the measured window, is above the smaller of 10 ms and the run's own p95 latency ("the generator lags more than the latency it measures");
- the machine was not quiet at the start;
- any latency is negative (the clocks disagree).

If a run is invalid because of the generator's lag, it is repeated with one more generator process (at most 8). This is part of the validity rule and not a tuning of the load: the load and the server are the same. If a size cannot be measured validly with 8 generator processes, the size is reported as not measurable and the numbers of its invalid runs are shown marked invalid.

A run is **failed** when the server is the reason it is not clean. A failed run is a result. It is reported, it counts as one of the three runs of its size, and it is not repeated to find a better one:

- an editor was disconnected during the run, was refused at the handshake or received a `rejected` notice;
- the server logged a warning or an error during the run;
- a delivery is missing after the drain, was delivered twice, or matches no send;
- an editor ended with a different document from the others, or the database does not hold the document the editors ended with (read back from the snapshot and the log).

A run that is both invalid and failed is invalid. Its failure reasons are kept in the file.

### Not measured

- Browsers: no rendering, no TipTap, no ProseMirror. The latency is to the receiving `Y.Doc`, not to the pixel.
- Any network: no WAN, TLS, proxy or load balancer, and no Wi-Fi.
- More than one server instance (the Redis relay between instances), and more than one document at the same time.
- A large or old document: the log is short and the snapshot small.
- Viewers (read-only sockets). All editors are editors.
- Server event-loop lag, and the CPU and memory of Redis and PostgreSQL. Only the server process is sampled.
- Long runs: each is 70 seconds of editing plus the drain.
- Reconnection storms. The editors do not reconnect during a run; a disconnect fails the run.

### How the harness was checked

The statistics (percentile, join of sends and receipts, validity rules, `ps` and `top` parsing) have unit tests (`apps/collab/test/bench-*.test.ts`). The harness was exercised before this page was committed with unmeasured smoke runs of 10 editors (8 seconds) and 50 editors (15 seconds), whose output was thrown away; they found a bug in the event-loop figure (Node reports the timer interval as part of the delay, hence the subtraction above). They were made after the parameters above had been chosen, and none of the parameters was changed because of them.

## Reproducing

```sh
createdb collabdocs_bench
export DATABASE_URL=postgresql://you@localhost:5432/collabdocs_bench
npm run db:deploy
redis-server --port 6397 --save '' --appendonly no &
export REDIS_URL=redis://localhost:6397

cd apps/collab
node --import tsx bench/run.ts --editors 50 --label 50-run1    # writes bench/results/50-run1.json
node --import tsx bench/run.ts --editors 50 --writer-share 1 --label allwrite-50-run1   # every editor types
```

`bench/run.ts` takes `--editors` and `--label`; every protocol value above is its default. It creates the document and the users, starts the server, runs, writes the file and removes what it created. `--skip-quiet-check` exists for trying the harness out; a result written with it is always marked invalid.

## Convergence test

`apps/collab/test/convergence.test.ts` is a fast-check property test against a real collab server. Three clients make random inserts, deletes and formatting changes (bold, on and off) on one `Y.Text` and insert and delete paragraphs in a `Y.XmlFragment`, hold their updates back and release them late, in random order and sometimes twice, apply what the server relays to them late and in random order, pause for random times, and go offline and come back through a new handshake. At the end they must all hold the same Yjs state as the database, the same text and the same formatting, and every token that was typed and not deleted must be in the text exactly once. It runs with `npm test` in about five seconds. A failure prints the seed and the run count; `FC_SEED=<seed> FC_RUNS=<runs> npx vitest run test/convergence.test.ts` repeats the same operations (the timing is real, so a failure that depends on timing may need a few tries).

## Changes to the protocol

The protocol above is unchanged for the nine runs it was written for (`50-run1` to `200-run3`, made from commit `8d8cecd`), and those results stay as they are. After they were published, two gaps were found, and the measurements below were added. Each entry says what was added, why, and what it applies to. Nothing here was chosen after seeing the numbers of the runs it applies to.

### Addendum 1: a scenario in which every editor writes

**Why.** In the nine runs only one editor in five types; at 50 editors, 10 type and 40 only read and move their cursor now and then. The second goal ("50 or more people editing one document at once, with live cursors and presence") was therefore only covered for 50 connected editors of whom 10 typed. This scenario measures it with everyone typing. It was added after the first results, prompted by that gap, and committed before its first run.

**What.** The same protocol with one difference: every editor is a writer (`--writer-share 1`). Per editor the rate is the same, 3 edits per second on average with the same jitter, and the cursor behaves as it does for the writers above (moves with every character). Sizes: 50 and 100 editors, 3 runs each, in rounds (50, 100, 50, 100, 50, 100), fresh server, document and users per run, default limits, same machine, same quiet-machine rule, same generator rule (at most 40 editors per process: 2 and 3 processes). The total edit rate is 150 and 300 edits per second, each delivered to 49 and 99 other editors. Results files are named `allwrite-<size>-run<k>.json` and carry `parameters.scenario: "all-write"`. Before this addendum was committed, the changed code (writer share, lag meter, clock skew) was exercised with one unmeasured 20-editor all-write smoke run of 8 seconds, whose output was thrown away.

**Validity.** The rules of [An invalid run, and a failed one](#an-invalid-run-and-a-failed-one) apply unchanged, including the repeat with one more generator process when the generator lags. If the default limits throttle or disconnect any editor, that is a failed run and is the result: no limit is raised and the run is not repeated to get a clean one.

**What it supports.** The goal-2 verdict rests on these runs. The latency claim (p95 at 50 editors) stays defined on the one-in-five runs, as written; the all-write runs are reported next to them and do not enter the claim.

### Addendum 2: clock skew between processes

The processes use `performance.timeOrigin + performance.now()`, and each takes its time origin at its own start, so a small constant offset between processes is possible. Before every run starting with the all-write runs, the orchestrator measures the offset of each generator process's clock from its own (200 ping-pong exchanges per process; the exchange with the shortest round trip is used, as NTP does, and half its round trip is the stated uncertainty) and records both in the results file (`clockSkewBetweenGeneratorsAndOrchestrator`). The skew is not subtracted. If it is not small against the p50 latency, the results say so. The nine earlier files carry no such measurement.

### Addendum 3: the event-loop lag meter

The nine earlier files measure the generator's event-loop delay with Node's `monitorEventLoopDelay`, and their `max` values (4 to 69 ms) were reported but not understood; the protocol's rule uses p99, which was followed. An experiment (an idle process, histogram enabled after three seconds) shows no start-up spike, so the first interval after `enable()` is not the cause; the large values are real stalls of the generator process (garbage collection, scheduling) that the p99 does not show. From the all-write runs on, the lag is measured with a timer of our own (`bench/lag.ts`, 5 ms interval, lateness of each tick; it has unit tests including a deliberate 50 ms block) which also records when in the window the largest delay happened (`maxAtMs`). Both p99 and max are recorded; the validity rule stays p99 against the smaller of 10 ms and the run's p95. An idle loop reads about a millisecond on this meter (timer slop), which is not lag.

### Addendum 4: server limits and presence checks added after the runs

After the fifteen runs, the collab server gained three things that touch the traffic the load test produces, and the load generator one change. **No run was repeated: the results files are the runs of the earlier code.**

- **Presence is checked against the token.** The server refuses an awareness state that does not carry `user.id` equal to the socket's user, and shows the name from the token. The load generator's editors therefore announce `{ user: { id, name, color } }` (the user id they sign in as, and the name in their token) instead of `{ user: { name, color } }`: about 30 bytes more per awareness message. The commit of the earlier code is in every results file.
- **An outbound cap per socket** (`COLLAB_MAX_OUTBOUND_BYTES`, 4 MiB by default). Before every send, a socket with more queued for it than the cap is disconnected. The load cannot reach it. The largest per-socket queue the load can produce, from the delivery rates in the results files: in the all-write run with 100 editors a socket is sent about 300 sync messages and 300 awareness messages per second. At 1 KiB each, several times their real size (a sync message for one character is a few tens of bytes, an awareness message a couple of hundred, plus Socket.IO framing), that is about 600 KiB per second, so a socket that stopped reading for the whole 5-second drain would have 3 MB queued, under the cap; at the real sizes it is well under 1 MB. The worst event-loop stall of a generator process in any run was 69 ms, which is about 40 KiB at that rate. The join reply (the document is under 10 KB, the present awareness states under 100 KB) is far below it. This is arithmetic on the recorded rates, not a measurement of the queue.
- **Replies are charged to the byte budgets.** The answer to a sync step 1 counts against the socket's and the user's byte budgets (2 MiB and 4 MiB bursts). Each editor of a run is its own user and receives one reply of under 10 KB.

The all-write and one-in-five results therefore describe a server without these checks; the checks add a few comparisons per send and, per awareness message, a JSON parse and an encode of one state.

### Notes that do not change any measurement

- The load test edits a `Y.Text`, as in the nine runs, so that its numbers are comparable. The collab server relays Yjs updates without interpreting them, so the type of the shared structure does not change what it does. The editor's own structure is a `Y.XmlFragment` of paragraphs; the convergence test covers it.
- The convergence test now also holds, shuffles and delays what the server relays to each client (not only what clients send), and has an operation family on paragraphs in a `Y.XmlFragment`. A mutation that makes the relay drop an update to some clients fails it; a mutation that only delays or reorders relayed updates does not, because Yjs applies updates in any order.
