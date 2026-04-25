#!/usr/bin/env bash
# Empleo Automatico MX - Google Sign-In integration tests.
#
# Covers (no real Google round-trip):
#   1. POST /v1/auth/google with malformed body -> 400 VALIDATION_ERROR
#   2. POST /v1/auth/google with garbage idToken -> 401 GOOGLE_TOKEN_INVALID
#      (or 503 GOOGLE_OAUTH_DISABLED when GOOGLE_CLIENT_ID is unset)
#   3. POST /v1/auth/google with missing idToken -> 400 VALIDATION_ERROR
#
# Issuing a real signed Google ID token requires a live consent flow, so
# this suite stays within reject-paths. End-to-end success is exercised
# manually via the landing.
#
# Requirements: bash + curl + python3.
# Usage:
#   bash tests/integration/google-oauth.sh
#
# Env overrides:
#   API=http://localhost:8787/v1   (default)

set -u

API=${API:-http://localhost:8787/v1}
PASS=0
FAIL=0
TESTS_RUN=0

jgetp() {
  local path="$1"
  python3 - "$path" <<'PY' 2>/dev/null
import json, sys
path = sys.argv[1]
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
cur = data
for p in path.split('.'):
    if isinstance(cur, dict) and p in cur:
        cur = cur[p]
    else:
        sys.exit(0)
print(cur if not isinstance(cur, (dict, list)) else json.dumps(cur))
PY
}

assert_equals() {
  local label="$1"; local expected="$2"; local actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "[google-oauth] API=$API"

# Test 1: malformed JSON body.
echo "Test 1: POST /auth/google with malformed JSON body"
res=$(curl -sS -o /tmp/google_t1.json -w "%{http_code}" \
  -X POST "$API/auth/google" \
  -H "Content-Type: application/json" \
  -d 'not-json')
code=$(cat /tmp/google_t1.json | jgetp error.code)
assert_equals "status is 400" "400" "$res"
assert_equals "error.code is VALIDATION_ERROR" "VALIDATION_ERROR" "$code"

# Test 2: garbage idToken — backend either rejects with 401
# (GOOGLE_TOKEN_INVALID, when GOOGLE_CLIENT_ID is configured) or with 503
# (GOOGLE_OAUTH_DISABLED, when not).
echo "Test 2: POST /auth/google with invalid idToken"
res=$(curl -sS -o /tmp/google_t2.json -w "%{http_code}" \
  -X POST "$API/auth/google" \
  -H "Content-Type: application/json" \
  -d '{"idToken":"aaaa.bbbb.cccc"}')
code=$(cat /tmp/google_t2.json | jgetp error.code)
TESTS_RUN=$((TESTS_RUN + 1))
if [ "$res" = "401" ] && [ "$code" = "GOOGLE_TOKEN_INVALID" ]; then
  echo "  PASS: rejected as GOOGLE_TOKEN_INVALID (GOOGLE_CLIENT_ID is set)"
  PASS=$((PASS + 1))
elif [ "$res" = "503" ] && [ "$code" = "GOOGLE_OAUTH_DISABLED" ]; then
  echo "  PASS: rejected as GOOGLE_OAUTH_DISABLED (GOOGLE_CLIENT_ID unset)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: unexpected response status=$res code=$code"
  FAIL=$((FAIL + 1))
fi

# Test 3: missing idToken field.
echo "Test 3: POST /auth/google with missing idToken"
res=$(curl -sS -o /tmp/google_t3.json -w "%{http_code}" \
  -X POST "$API/auth/google" \
  -H "Content-Type: application/json" \
  -d '{}')
code=$(cat /tmp/google_t3.json | jgetp error.code)
assert_equals "status is 400" "400" "$res"
assert_equals "error.code is VALIDATION_ERROR" "VALIDATION_ERROR" "$code"

echo
echo "[google-oauth] $PASS/$TESTS_RUN passed, $FAIL failed."
[ "$FAIL" -eq 0 ] || exit 1
exit 0
