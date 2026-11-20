#!/usr/bin/env bash
# Runs every check that CI runs, on this machine.
# usage: scripts/preflight.sh   (or: npm run preflight)
#
# The tests need PostgreSQL. DATABASE_URL names the database; the name must
# contain "test", because the tests delete every row. Unset, it defaults to a
# collabdocs_test database on localhost, created if it is missing.
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

step "migrations"
npm run --silent db:deploy
# The migrations must produce exactly the schema that prisma/schema.prisma describes.
npm run --silent db:drift -w apps/web

step "tests"
npm run --silent test:scripts
npm run --silent test

step "build"
npm run --silent build

echo
echo "preflight: ok"
