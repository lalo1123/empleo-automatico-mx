#!/usr/bin/env bash
# Empleo Automatico MX - integration test for POST /v1/applications/generate-cv.
#
# Walks the full happy path:
#   1. Signup (free plan)
#   2. Verify email (admin/dev backdoor — see notes below)
#   3. parse-cv with sample-cv.txt to populate UserProfile
#   4. POST /generate-cv with sample-job.json + parsed profile
#   5. Assert response shape: ok=true, html starts with <!doctype, summary is a string,
#      usage.current === 1, usage.limit === 3 (free plan)
#   6. POST /generate-cv with empty experience -> expect 422
#
# Requirements: bash + curl + python3 (UTF-8 JSON building).
# Usage:
#   bash tests/integration/generate-cv.sh
# Env overrides:
#   API=http://localhost:8787/v1   # default = local dev backend
#
# IMPORTANT: this script needs an environment where signup auto-verifies the
# email OR where there is a dev backdoor. We assume the test backend has
# `EMAIL_AUTOVERIFY=1` (or equivalent) so freshly signed-up users can call
# email-gated endpoints. In production we don't run this script against the
# real env.

set +u
set -e

API=${API:-http://localhost:8787/v1}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v cygpath >/dev/null 2>&1; then
  HERE_WIN="$(cygpath -w "$HERE")"
else
  HERE_WIN="$HERE"
fi

RUN_ID=$(date +%s)$RANDOM
EMAIL="cvtester+${RUN_ID}@test.skybrandmx.com"
PASSWORD="supersecret123"
NAME="CV Tester"

PASS=0
FAIL=0

ok()   { printf "\033[32mPASS\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "\033[31mFAIL\033[0m %s\n  %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }

contains() { printf "%s" "$1" | grep -qF "$2"; }

# --- helpers ---------------------------------------------------------------

http_req() {
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"; shift || true
  local args=(-sS -X "$method" -o - -w "\n__STATUS__%{http_code}")
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" --data "$data")
  fi
  while [[ $# -gt 0 ]]; do
    args+=(-H "$1"); shift
  done
  local out
  out=$(curl "${args[@]}" "$url" 2>/dev/null)
  local status body
  status=$(printf "%s" "$out" | awk -F'__STATUS__' 'NF>1 { print $2 }')
  body=$(printf "%s"   "$out" | awk '/__STATUS__/ { exit } { print }')
  printf "%s\n" "$status"
  printf "%s"   "$body"
}

_status() { printf "%s" "$1" | sed -n '1p'; }
_body()   { printf "%s" "$1" | awk 'NR>=2 { print }'; }

# --- 1. signup -------------------------------------------------------------

echo "== generate-cv integration test =="
echo "API=$API"
echo "Run id: $RUN_ID"
echo ""

SIGNUP_BODY='{"email":"'"$EMAIL"'","password":"'"$PASSWORD"'","name":"'"$NAME"'"}'
R=$(http_req POST "$API/auth/signup" "$SIGNUP_BODY")
S=$(_status "$R"); B=$(_body "$R")
if [[ "$S" != "201" ]]; then
  fail "signup" "status=$S body=${B:0:200}"
  exit 1
fi
TOKEN=$(printf "%s" "$B" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
USER_ID=$(printf "%s" "$B" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [[ -z "$TOKEN" ]]; then
  fail "signup" "no token in body=${B:0:200}"
  exit 1
fi
ok "signup -> token + user id"

# --- 2. verify email (best-effort) -----------------------------------------
# The /generate-cv endpoint requires email verification. In dev/CI we expect
# the backend to have a verification backdoor. If neither exists, this whole
# script will hit 403 EMAIL_NOT_VERIFIED at step 4 — we then surface that as
# an environment skip rather than a failure.

VERIFIED=0
# Try a hypothetical dev-only endpoint first.
R=$(http_req POST "$API/auth/dev-verify-email" "{\"email\":\"$EMAIL\"}" "Authorization: Bearer $TOKEN")
S=$(_status "$R")
if [[ "$S" == "200" ]] || [[ "$S" == "204" ]]; then
  VERIFIED=1
  ok "verify email via /auth/dev-verify-email"
else
  # Fall back to seeing if the env auto-verifies on signup. We probe by
  # hitting a verified-only endpoint and continuing — the real verification
  # step is observable at the /generate-cv call below.
  echo "  note: no /auth/dev-verify-email (status=$S); continuing — backend may auto-verify."
fi

# --- 3. parse-cv -----------------------------------------------------------

PYTHONIOENCODING=utf-8 python3 - > "$HERE/.cv.json" 2>/dev/null <<PY
import json
txt=open(r"$HERE_WIN\sample-cv.txt","r",encoding="utf-8").read()
print(json.dumps({"text":txt},ensure_ascii=False))
PY
if [[ ! -s "$HERE/.cv.json" ]]; then
  fail "build parse-cv payload" "python3 missing or sample-cv.txt unreadable"
  exit 1
fi

OUT=$(curl -sS -w "\n__STATUS__%{http_code}" \
  -X POST "$API/applications/parse-cv" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@$HERE_WIN\\.cv.json")
S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }')
B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')
if [[ "$S" != "200" ]]; then
  fail "parse-cv" "status=$S body=${B:0:200}"
  exit 1
fi
ok "parse-cv returned UserProfile"

# Extract the parsed profile from the response and merge with sample-job into
# the /generate-cv body. We use python to keep UTF-8 + nested-JSON sane.
printf "%s" "$B" > "$HERE/.parsecv.json"
PYTHONIOENCODING=utf-8 python3 - > "$HERE/.gen-cv.json" 2>/dev/null <<PY
import json
resp=json.load(open(r"$HERE_WIN\.parsecv.json","r",encoding="utf-8"))
profile=resp["profile"]
job=json.load(open(r"$HERE_WIN\sample-job.json","r",encoding="utf-8"))
print(json.dumps({"profile":profile,"job":job},ensure_ascii=False))
PY
if [[ ! -s "$HERE/.gen-cv.json" ]]; then
  fail "build generate-cv payload" "python3 fusion failed"
  exit 1
fi

# --- 4. /generate-cv happy path --------------------------------------------

OUT=$(curl -sS -w "\n__STATUS__%{http_code}" \
  -X POST "$API/applications/generate-cv" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@$HERE_WIN\\.gen-cv.json")
S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }')
B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')

if [[ "$S" == "403" ]] && contains "$B" 'EMAIL_NOT_VERIFIED'; then
  fail "generate-cv (env skip)" "EMAIL_NOT_VERIFIED — backend has no auto-verify; cannot test in this env"
  echo "  hint: enable a dev verification backdoor to run this test."
  exit 1
fi

if [[ "$S" != "200" ]]; then
  fail "generate-cv 200" "status=$S body=${B:0:300}"
  exit 1
fi
if ! contains "$B" '"ok":true'; then
  fail "generate-cv ok=true" "body=${B:0:300}"; exit 1
fi
if ! contains "$B" '"html"'; then
  fail "generate-cv html field" "body=${B:0:300}"; exit 1
fi
if ! contains "$B" '"summary"'; then
  fail "generate-cv summary field" "body=${B:0:300}"; exit 1
fi
# Loose check that html actually starts with a doctype (escapes survive JSON).
if ! contains "$B" '<!doctype' && ! contains "$B" '<!DOCTYPE'; then
  fail "generate-cv html doctype" "html does not start with <!doctype>: ${B:0:300}"; exit 1
fi
if ! contains "$B" '"usage"'; then
  fail "generate-cv usage" "body=${B:0:300}"; exit 1
fi
# Free plan limit is 3 (see backend/src/lib/plans.ts).
if ! contains "$B" '"limit":3'; then
  fail "generate-cv usage.limit=3" "body=${B:0:300}"; exit 1
fi
if ! contains "$B" '"current":1'; then
  fail "generate-cv usage.current=1" "body=${B:0:300}"; exit 1
fi
ok "generate-cv happy path -> html + summary + usage 1/3"

# --- 5. /generate-cv with empty experience -> 422 --------------------------

PYTHONIOENCODING=utf-8 python3 - > "$HERE/.gen-cv-thin.json" 2>/dev/null <<PY
import json
gen=json.load(open(r"$HERE_WIN\.gen-cv.json","r",encoding="utf-8"))
gen["profile"]["experience"]=[]
print(json.dumps(gen,ensure_ascii=False))
PY

OUT=$(curl -sS -w "\n__STATUS__%{http_code}" \
  -X POST "$API/applications/generate-cv" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@$HERE_WIN\\.gen-cv-thin.json")
S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }')
B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')
if [[ "$S" != "422" ]]; then
  fail "generate-cv thin payload -> 422" "status=$S body=${B:0:200}"
else
  ok "generate-cv with empty experience -> 422"
fi

# --- summary ---------------------------------------------------------------

# Cleanup tmp files but leave them on failure for debugging.
if [[ $FAIL -eq 0 ]]; then
  rm -f "$HERE/.cv.json" "$HERE/.parsecv.json" "$HERE/.gen-cv.json" "$HERE/.gen-cv-thin.json"
fi

echo ""
echo "================================================"
printf "PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
echo "================================================"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
