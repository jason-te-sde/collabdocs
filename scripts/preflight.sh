#!/usr/bin/env bash
# Runs every check that CI runs, on this machine.
# usage: scripts/preflight.sh   (or: npm run preflight)
#
# The tests need PostgreSQL and Redis. DATABASE_URL names the database; the name
# must contain "test", because the tests delete every row. Unset, it defaults to
# a collabdocs_test database on localhost, created if it is missing. REDIS_URL
# defaults to redis://localhost:6379; the collab server tests use their own
# channel names and do not touch other keys. The e2e step starts the web app on
# port 3100 and a collab server on port 4100.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n== %s\n' "$*"; }

step "hygiene"
node scripts/check-hygiene.mjs
node --test scripts/check-hygiene.test.mjs

step "format"
npm run --silent format:check

step "lint"
npm run --silent lint

step "typecheck"
npm run --silent typecheck

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgresql://$(whoami)@localhost:5432/collabdocs_test"
  if ! psql -d postgres -Atc "select 1 from pg_database where datname = 'collabdocs_test'" | grep -q 1; then
    createdb collabdocs_test
  fi
fi

if [ -z "${REDIS_URL:-}" ]; then
  export REDIS_URL="redis://localhost:6379"
fi
if ! redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  echo "preflight: Redis is not reachable at $REDIS_URL (brew services start redis)" >&2
  exit 1
fi

step "migrations"
npm run --silent db:deploy
# The migrations must produce exactly the schema that prisma/schema.prisma describes.
npm run --silent db:drift -w apps/web

step "tests"
npm run --silent test:scripts
node scripts/benchmarks/readme-numbers.mjs
npm run --silent test

step "build"
npm run --silent build

# Two browsers against the built web app and a real collab server. Needs a
# browser: `npx playwright install chromium`, or PW_CHANNEL=chrome for an
# installed Google Chrome.
step "e2e"
npm run --silent test:e2e

echo
echo "preflight: ok"
