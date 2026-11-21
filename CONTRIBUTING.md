# Contributing

## Set up

Follow [Run it locally](README.md#run-it-locally). Then `npm run preflight` must pass on a clean checkout.

## Rules the build enforces

- **English only.** Code, comments, documentation, commit messages, test names and log lines. CI fails on any CJK character in a tracked file, a file name or a commit message, in any Unicode plane.
- **No attribution lines.** Commit messages, pull request text and files are the author's own work: no tool credit, no co-author trailer. CI fails on the patterns in `scripts/attribution-patterns.txt` (any co-author trailer, any line that credits a generator tool, a vendor's no-reply address, and a few more). It scans the whole history, so one bad commit fails every later push until it is rewritten.
- **TypeScript is strict,** ESLint has no warnings and Prettier has nothing to change (`npm run format` fixes formatting).
- **Every route checks the session and then `can(role, action)`.** A non-member gets 404, never 403. A new route needs a test for each role: owner, editor, viewer, a non-member and no session.
- **The database holds the invariants.** If a rule must always be true (one owner, one membership per user), put it in a constraint or a trigger in the migration and add a test in `apps/web/test/db-invariants.test.ts`.
- **No secret in the repository.** `apps/web/.env` is ignored; `.env.example` has empty values.

## Making a change

1. Write the test first and watch it fail for the right reason.
2. Make it pass with the smallest change.
3. Run `npm run preflight`.
4. Commit one focused change at a time, with a message that says why. The first line is a short imperative sentence.

## Schema changes

Edit `apps/web/prisma/schema.prisma`, then `npm run db:migrate -w apps/web -- --create-only --name what_changed`, read the SQL, add any constraint Prisma cannot express, and commit the migration. Never edit a migration that has been merged; add a new one. `npm run db:drift -w apps/web` fails when the migrations and the schema disagree.

## Dependencies

Versions are pinned exactly for the framework and the tools listed under "Things that will bite" in the README. A new dependency needs a reason in the commit message.
