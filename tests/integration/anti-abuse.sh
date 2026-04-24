#!/usr/bin/env bash
# Empleo Automatico MX - anti-abuse integration tests.
#
# Covers:
#   1. Signup with disposable email   -> 400 EMAIL_NOT_ALLOWED
#   2. Signup without Turnstile token -> 400 CAPTCHA_FAILED (when TURNSTILE_SECRET set)
#   3. Signup returns requiresVerification + verificationUrl
#   4. POST /applications/generate BEFORE verify -> 403 EMAIL_NOT_VERIFIED
#   5. POST /auth/verify-email with the issued token -> 200
#   6. POST /applications/generate AFTER verify -> 200 or 402 (quota), NOT 403
#
# Requirements: bash + curl + python3 (json parsing). No jq.
# Usage:
#   bash tests/integration/anti-abuse.sh
#
# Env overrides:
#   API=http://localhost:8787/v1          (default)
#   TURNSTILE_SECRET_SET=1                (if the backend has TURNSTILE_SECRET set,
#                                          enables test 2. Otherwise it's skipped.)

set -u

API=${API:-http://localhost:8787/v1}
TURNSTILE_SECRET_SET=${TURNSTILE_SECRET_SET:-0}

PASS=0
FAIL=0
TESTS_RUN=0

RUN_ID=$(date +%s)$RANDOM
EMAIL="abuse+${RUN_ID}@test.skybrandmx.com"
# A domain from backend/src/lib/disposable-domains.ts. Change if the list shifts.
DISPOSABLE_EMAIL="abuse+${RUN_ID}@mailinator.com"
PASSWORD="supersecret123"
NAME="Ana Abuse-Tester"

# --------- helpers ---------------------------------------------------------

# Minimal JSON field extractor using python3. Feeds payload via stdin.
# Args: JSONPATH (dotted, e.g. "error.code", "verification.token").
# Returns empty on miss.
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

# curl wrapper: prints "<status>\n<body>"
http_post_json() {
  local url="$1" data="$2" auth="${3:-}"
  local args=(-sS -o - -w "\n__STATUS__%{http_code}" -X POST -H "Content-Type: application/json" --data "$data")
  if [[ -n "$auth" ]]; then
    args+=(-H "Authorization: Bearer $auth")
  fi
  local out status body
  out=$(curl "${args[@]}" "$url" 2>/dev/null || true)
  status=$(printf "%s" "$out" | sed -n 's/.*__STATUS__\([0-9][0-9][0-9]\).*/\1/p' | tail -n1)
  body=$(printf "%s" "$out" | sed 's/__STATUS__[0-9][0-9][0-9]$//')
  printf "%s\n%s" "$status" "$body"
}

pass() {
  local id="$1" name="$2"
  TESTS_RUN=$((TESTS_RUN+1))
  PASS=$((PASS+1))
  printf "[%02d] \033[32mPASS\033[0m  %s\n" "$id" "$name"
}

fail() {
  local id="$1" name="$2" detail="$3"
  TESTS_RUN=$((TESTS_RUN+1))
  FAIL=$((FAIL+1))
  printf "[%02d] \033[31mFAIL\033[0m  %s  (%s)\n" "$id" "$name" "$detail"
}

skip() {
  local id="$1" name="$2" reason="$3"
  printf "[%02d] \033[33mSKIP\033[0m  %s  (%s)\n" "$id" "$name" "$reason"
}

# --------- preflight -------------------------------------------------------

printf "==> Anti-abuse suite against %s\n" "$API"
if ! curl -fsS "$API/../" >/dev/null 2>&1 && ! curl -fsS "${API%/v1}/healthz" >/dev/null 2>&1; then
  printf "[preflight] WARN: backend at %s not reachable — tests will fail\n" "$API"
fi

# --------- Test 1: disposable email blocked ------------------------------

TEST_ID=1
TEST_NAME="signup with disposable email -> EMAIL_NOT_ALLOWED"
DATA=$(printf '{"email":"%s","password":"%s","name":"%s"}' "$DISPOSABLE_EMAIL" "$PASSWORD" "$NAME")
OUT=$(http_post_json "$API/auth/signup" "$DATA")
STATUS=$(printf "%s" "$OUT" | sed -n '1p')
BODY=$(printf "%s" "$OUT" | sed -n '2,$p')
CODE=$(printf "%s" "$BODY" | jgetp "error.code")
if [[ "$STATUS" == "400" && "$CODE" == "EMAIL_NOT_ALLOWED" ]]; then
  pass "$TEST_ID" "$TEST_NAME"
else
  fail "$TEST_ID" "$TEST_NAME" "status=$STATUS code=$CODE"
fi

# --------- Test 2: missing Turnstile -------------------------------------

TEST_ID=2
TEST_NAME="signup without Turnstile token (when secret set) -> CAPTCHA_FAILED"
if [[ "$TURNSTILE_SECRET_SET" != "1" ]]; then
  skip "$TEST_ID" "$TEST_NAME" "TURNSTILE_SECRET_SET=0"
else
  EMAIL_T="abuse-captcha+${RUN_ID}@test.skybrandmx.com"
  DATA=$(printf '{"email":"%s","password":"%s"}' "$EMAIL_T" "$PASSWORD")
  OUT=$(http_post_json "$API/auth/signup" "$DATA")
  STATUS=$(printf "%s" "$OUT" | sed -n '1p')
  BODY=$(printf "%s" "$OUT" | sed -n '2,$p')
  CODE=$(printf "%s" "$BODY" | jgetp "error.code")
  if [[ "$STATUS" == "400" && "$CODE" == "CAPTCHA_FAILED" ]]; then
    pass "$TEST_ID" "$TEST_NAME"
  else
    fail "$TEST_ID" "$TEST_NAME" "status=$STATUS code=$CODE"
  fi
fi

# --------- Test 3: happy-path signup returns verification payload --------

TEST_ID=3
TEST_NAME="signup returns requiresVerification + token"
DATA=$(printf '{"email":"%s","password":"%s","name":"%s"}' "$EMAIL" "$PASSWORD" "$NAME")
OUT=$(http_post_json "$API/auth/signup" "$DATA")
STATUS=$(printf "%s" "$OUT" | sed -n '1p')
BODY=$(printf "%s" "$OUT" | sed -n '2,$p')
REQUIRES=$(printf "%s" "$BODY" | jgetp "requiresVerification")
VERIFY_TOKEN=$(printf "%s" "$BODY" | jgetp "verification.token")
SESSION_TOKEN=$(printf "%s" "$BODY" | jgetp "token")
if [[ "$STATUS" == "201" && "$REQUIRES" == "True" && -n "$VERIFY_TOKEN" && -n "$SESSION_TOKEN" ]]; then
  pass "$TEST_ID" "$TEST_NAME"
else
  fail "$TEST_ID" "$TEST_NAME" "status=$STATUS requires=$REQUIRES hasVerifyToken=${VERIFY_TOKEN:+yes} hasSession=${SESSION_TOKEN:+yes}"
fi

# --------- Test 4: generate blocked before verify -------------------------

TEST_ID=4
TEST_NAME="POST /applications/generate BEFORE verify -> EMAIL_NOT_VERIFIED"
if [[ -z "$SESSION_TOKEN" ]]; then
  skip "$TEST_ID" "$TEST_NAME" "no session token from test 3"
else
  # Minimal valid-shape body — doesn't matter, we hit the verification guard first.
  GEN_BODY='{"profile":{"personal":{"fullName":"X","email":"x@example.com","phone":"1","location":"MX"},"summary":"s","experience":[],"education":[],"skills":[],"languages":[]},"job":{"source":"occ","url":"https://example.com","id":"1","title":"Dev","company":"C","location":"L","salary":null,"modality":null,"description":"d","requirements":[],"extractedAt":"2026-01-01"}}'
  OUT=$(http_post_json "$API/applications/generate" "$GEN_BODY" "$SESSION_TOKEN")
  STATUS=$(printf "%s" "$OUT" | sed -n '1p')
  BODY=$(printf "%s" "$OUT" | sed -n '2,$p')
  CODE=$(printf "%s" "$BODY" | jgetp "error.code")
  if [[ "$STATUS" == "403" && "$CODE" == "EMAIL_NOT_VERIFIED" ]]; then
    pass "$TEST_ID" "$TEST_NAME"
  else
    fail "$TEST_ID" "$TEST_NAME" "status=$STATUS code=$CODE"
  fi
fi

# --------- Test 5: verify-email consumes the token ------------------------

TEST_ID=5
TEST_NAME="POST /auth/verify-email with issued token -> 200"
if [[ -z "$VERIFY_TOKEN" ]]; then
  skip "$TEST_ID" "$TEST_NAME" "no verify token"
else
  DATA=$(printf '{"token":"%s"}' "$VERIFY_TOKEN")
  OUT=$(http_post_json "$API/auth/verify-email" "$DATA")
  STATUS=$(printf "%s" "$OUT" | sed -n '1p')
  BODY=$(printf "%s" "$OUT" | sed -n '2,$p')
  OK=$(printf "%s" "$BODY" | jgetp "ok")
  if [[ "$STATUS" == "200" && "$OK" == "True" ]]; then
    pass "$TEST_ID" "$TEST_NAME"
  else
    fail "$TEST_ID" "$TEST_NAME" "status=$STATUS ok=$OK"
  fi
fi

# --------- Test 6: generate works AFTER verify ---------------------------

TEST_ID=6
TEST_NAME="POST /applications/generate AFTER verify -> not EMAIL_NOT_VERIFIED"
if [[ -z "$SESSION_TOKEN" ]]; then
  skip "$TEST_ID" "$TEST_NAME" "no session token"
else
  GEN_BODY='{"profile":{"personal":{"fullName":"X","email":"x@example.com","phone":"1","location":"MX"},"summary":"s","experience":[],"education":[],"skills":[],"languages":[]},"job":{"source":"occ","url":"https://example.com","id":"1","title":"Dev","company":"C","location":"L","salary":null,"modality":null,"description":"d","requirements":[],"extractedAt":"2026-01-01"}}'
  OUT=$(http_post_json "$API/applications/generate" "$GEN_BODY" "$SESSION_TOKEN")
  STATUS=$(printf "%s" "$OUT" | sed -n '1p')
  BODY=$(printf "%s" "$OUT" | sed -n '2,$p')
  CODE=$(printf "%s" "$BODY" | jgetp "error.code")
  # Success = NOT blocked on verification. Body may still fail downstream
  # (Gemini upstream, plan limits). We accept 200, 402 (quota) or any 5xx
  # from Gemini, but NEVER 403 EMAIL_NOT_VERIFIED.
  if [[ "$CODE" != "EMAIL_NOT_VERIFIED" ]]; then
    pass "$TEST_ID" "$TEST_NAME"
  else
    fail "$TEST_ID" "$TEST_NAME" "status=$STATUS code=$CODE"
  fi
fi

# --------- summary ---------------------------------------------------------

printf "\n==> %d tests, %d passed, %d failed\n" "$TESTS_RUN" "$PASS" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
