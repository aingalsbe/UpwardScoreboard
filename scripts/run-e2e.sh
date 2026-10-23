#!/bin/bash
# Run e2e scripts, each against a fresh database + fresh server, on the TEST CLOCK (see SETUP.md "Test clock").
# usage: scripts/run-e2e.sh <script...>     e.g. scripts/run-e2e.sh smoke.mjs flow-e2e.mjs
# Env: E2E_PG (postgres server URL, default postgres://postgres@127.0.0.1:55432), E2E_PORT (default 18610),
#      E2E_REAL_CLOCK=1 to run on the real clock (only passes on Fri/Sat 08:00–21:00 league time).
# SCOREBOARD_TEST_CLOCK=1 (explicit opt-in) + SCOREBOARD_TEST_NOW = the next game day (Fri 10:00 league time, scripts/_gameday.mjs) is given to the seed, the
# server and the script, so games created "now" are legal on any weekday. The database is always *_test_e2e.
set -u
D=$(cd "$(dirname "$0")/.." && pwd); PORT=${E2E_PORT:-18610}; DB=scoreboard_test_e2e; PG=${E2E_PG:-postgres://postgres@127.0.0.1:55432}
rc=0
for s in "$@"; do
  if [ "${E2E_REAL_CLOCK:-}" = 1 ]; then unset SCOREBOARD_TEST_NOW SCOREBOARD_TEST_CLOCK
  else export SCOREBOARD_TEST_CLOCK=1 SCOREBOARD_TEST_NOW=$(cd "$D" && env -u SCOREBOARD_TEST_NOW -u SCOREBOARD_TEST_CLOCK node --input-type=module -e "import('./scripts/_gameday.mjs').then((m) => console.log(m.nextGameDay().toISOString()))"); fi
  psql "$PG/postgres" -qc "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null
  (cd "$D" && DATABASE_URL=$PG/$DB TZ=America/Chicago node dist/src/seed-demo.js >/dev/null 2>&1)
  (cd "$D"; exec env DATABASE_URL=$PG/$DB PORT=$PORT ADMIN_PASSWORD=change-me-admin SESSION_SECRET=x-test-secret-long-enough COURT_PINS=full:1111,west:2222,east:3333 SEED=true TZ=America/Chicago GAME_MINUTES=60 LEAGUE_NAME="Lenexa Baptist Church Youth Basketball" CHURCH_NAME="Lenexa Baptist Church" node dist/src/server.js > /tmp/e2e-srv.log 2>&1) & SRV=$!
  for i in $(seq 40); do curl -sf localhost:$PORT/ >/dev/null && break; sleep 0.5; done
  echo "=== $s (clock: ${SCOREBOARD_TEST_NOW:-real})"
  out=$(cd "$D" && BASE_URL=http://localhost:$PORT TZ=America/Chicago timeout 600 node scripts/$s 2>&1); code=$?
  echo "$out" | grep -E "FAIL|result|passed|Error" ; [ $code -ne 0 ] && { echo "  (exit $code)"; echo "$out" | tail -5; rc=1; }
  echo "$out" | grep -q "FAIL" && rc=1
  kill $SRV; wait $SRV 2>/dev/null
done
psql "$PG/postgres" -qc "DROP DATABASE IF EXISTS $DB" >/dev/null
exit $rc
