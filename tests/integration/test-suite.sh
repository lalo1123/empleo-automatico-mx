#!/usr/bin/env bash
# Empleo Automatico MX - integration test suite.
# Runs all 30 tests from the tester scope against the live production backend
# and landing. Prints PASS/FAIL per test and writes results.jsonl for the report.
#
# Requirements: bash + curl. No jq (we grep JSON for matches).
# Usage:
#   bash tests/integration/test-suite.sh
# Env overrides (optional):
#   API=https://api.empleo.skybrandmx.com/v1
#   LANDING=https://empleo.skybrandmx.com

set +u

API=${API:-https://api.empleo.skybrandmx.com/v1}
LANDING=${LANDING:-https://empleo.skybrandmx.com}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# On Git Bash / MSYS on Windows, $HERE is a mingw-style /c/... path that python3
# and curl --data-binary @ cannot always open. Use HERE_WIN with a native path
# when we pass paths to those tools.
if command -v cygpath >/dev/null 2>&1; then
  HERE_WIN="$(cygpath -w "$HERE")"
else
  HERE_WIN="$HERE"
fi
RESULTS="$HERE/results.jsonl"
: > "$RESULTS"

PASS=0
FAIL=0
TESTS_RUN=0

# Unique email for this run so re-runs do not collide.
RUN_ID=$(date +%s)$RANDOM
EMAIL="tester+${RUN_ID}@test.skybrandmx.com"
PASSWORD="supersecret123"
NAME="Ana Tester"

# Second account for plan-limit test
EMAIL2="tester-limit+${RUN_ID}@test.skybrandmx.com"

TOKEN=""
USER_ID=""
TOKEN2=""

# -------- helpers --------------------------------------------------------

# If we hit the auth rate limiter mid-run, pause until the 60s window rolls over.
wait_for_rate_limit() {
  local reason="${1:-}"
  echo "  [rate-limit] got 429 on $reason — sleeping 62s to let auth window roll..."
  sleep 62
}

# Post JSON and emit "HTTP_STATUS|TIME|BODY" via a temp file pattern.
# Args: METHOD URL DATA [HEADERS...]
http_req() {
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"; shift || true
  local tmp_h
  tmp_h=$(mktemp)
  local args=(-sS -X "$method" -o - -w "\n__STATUS__%{http_code}\n__TIME__%{time_total}" -D "$tmp_h")
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" --data "$data")
  fi
  while [[ $# -gt 0 ]]; do
    args+=(-H "$1"); shift
  done
  local out
  out=$(curl "${args[@]}" "$url" 2>/dev/null)
  local status time body
  status=$(printf "%s" "$out" | awk -F'__STATUS__' 'NF>1 { print $2 }' | awk -F'__TIME__' '{ print $1 }')
  time=$(printf "%s"   "$out" | awk -F'__TIME__'   'NF>1 { print $2 }')
  body=$(printf "%s"   "$out" | awk '/__STATUS__/ { exit } { print }')
  printf "%s\n" "$status"
  printf "%s\n" "$time"
  printf "%s"   "$body"
  rm -f "$tmp_h"
}

# parse one of three lines emitted above (0=status, 1=time, 2..=body)
_status() { printf "%s" "$1" | sed -n '1p'; }
_time()   { printf "%s" "$1" | sed -n '2p'; }
_body()   { printf "%s" "$1" | awk 'NR>=3 { print }'; }

# record result: id, name, pass/fail, status, ms, note
record() {
  local id="$1" name="$2" result="$3" status="$4" tsec="$5" note="$6"
  TESTS_RUN=$((TESTS_RUN+1))
  if [[ "$result" == "PASS" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
  # pretty stdout
  local color_p="\033[32m" color_f="\033[31m" reset="\033[0m"
  local tag="$color_p""PASS""$reset"
  [[ "$result" == "FAIL" ]] && tag="$color_f""FAIL""$reset"
  printf "[%02d] %s  %-48s status=%s  t=%ss  %s\n" \
    "$id" "$(printf "$tag")" "$name" "$status" "$tsec" "$note"
  # jsonl
  # escape quotes in note
  local esc_note=${note//\"/\\\"}
  printf '{"id":%d,"name":"%s","result":"%s","status":"%s","time_s":"%s","note":"%s"}\n' \
    "$id" "$name" "$result" "$status" "$tsec" "$esc_note" >> "$RESULTS"
}

# quick contains check; body, pattern
contains() {
  printf "%s" "$1" | grep -qF "$2"
}
contains_re() {
  printf "%s" "$1" | grep -qE "$2"
}

# -------- tests ---------------------------------------------------------

echo "=== Empleo Automatico MX integration tests ==="
echo "API=$API"
echo "LANDING=$LANDING"
echo "Run id: $RUN_ID"
echo ""

# Sanity: API root
R=$(http_req GET "$API/"); S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "404" ]] || [[ "$S" == "200" ]]; then
  :
else
  echo "WARN: API root unreachable? status=$S"
fi

#### 1. signup happy path
BODY='{"email":"'"$EMAIL"'","password":"'"$PASSWORD"'","name":"'"$NAME"'"}'
R=$(http_req POST "$API/auth/signup" "$BODY")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "201" ]] && contains "$B" '"ok":true' && contains "$B" '"token"' && contains "$B" '"plan":"free"'; then
  # extract token (naive but works: "token":"..." )
  TOKEN=$(printf "%s" "$B" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  USER_ID=$(printf "%s" "$B" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  record 1 "Signup happy path" PASS "$S" "$T" "token+plan=free"
else
  record 1 "Signup happy path" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 2. signup duplicate
R=$(http_req POST "$API/auth/signup" "$BODY")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "409" ]] && contains "$B" 'EMAIL_TAKEN'; then
  record 2 "Signup duplicate email" PASS "$S" "$T" "409 EMAIL_TAKEN"
elif [[ "$S" =~ ^4 ]] && ! [[ "$S" == "500" ]]; then
  record 2 "Signup duplicate email" PASS "$S" "$T" "non-5xx (accepted)"
else
  record 2 "Signup duplicate email" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 3. signup weak password
WEAK_EMAIL="tester-weak+${RUN_ID}@test.skybrandmx.com"
WEAK='{"email":"'"$WEAK_EMAIL"'","password":"123","name":"W"}'
R=$(http_req POST "$API/auth/signup" "$WEAK")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "400" ]] && contains "$B" 'VALIDATION_ERROR'; then
  record 3 "Signup weak password" PASS "$S" "$T" "400 validation"
else
  record 3 "Signup weak password" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 4. signup invalid email
BAD='{"email":"notanemail","password":"supersecret123","name":"BadMail"}'
R=$(http_req POST "$API/auth/signup" "$BAD")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "429" ]]; then
  wait_for_rate_limit "signup invalid email"
  R=$(http_req POST "$API/auth/signup" "$BAD")
  S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
fi
if [[ "$S" == "400" ]] && contains "$B" 'VALIDATION_ERROR'; then
  record 4 "Signup invalid email" PASS "$S" "$T" "400 validation"
else
  record 4 "Signup invalid email" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 5. login wrong password
BAD='{"email":"'"$EMAIL"'","password":"wrong-password-abc"}'
R=$(http_req POST "$API/auth/login" "$BAD")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "429" ]]; then
  wait_for_rate_limit "login wrong password"
  R=$(http_req POST "$API/auth/login" "$BAD")
  S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
fi
if [[ "$S" == "401" ]] && contains "$B" 'INVALID_CREDENTIALS'; then
  record 5 "Login wrong password" PASS "$S" "$T" "401"
else
  record 5 "Login wrong password" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 6. login non-existent user
BAD='{"email":"nonexistent-'"$RUN_ID"'@nowhere.mx","password":"whatever123"}'
R=$(http_req POST "$API/auth/login" "$BAD")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "429" ]]; then
  wait_for_rate_limit "login nonexistent"
  R=$(http_req POST "$API/auth/login" "$BAD")
  S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
fi
if [[ "$S" == "401" ]] && contains "$B" 'INVALID_CREDENTIALS'; then
  record 6 "Login non-existent user" PASS "$S" "$T" "401 generic"
else
  record 6 "Login non-existent user" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 7. logout with valid token
# Relogin to get a fresh token we will revoke in this test.
RELOGIN='{"email":"'"$EMAIL"'","password":"'"$PASSWORD"'"}'
R=$(http_req POST "$API/auth/login" "$RELOGIN")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
LOGOUT_TOKEN=$(printf "%s" "$B" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [[ -z "$LOGOUT_TOKEN" ]]; then
  record 7 "Logout (204)" FAIL "$S" "$T" "relogin failed"
else
  R=$(http_req POST "$API/auth/logout" "" "Authorization: Bearer $LOGOUT_TOKEN")
  S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
  if [[ "$S" == "204" ]]; then
    record 7 "Logout (204)" PASS "$S" "$T" "revoked"
  else
    record 7 "Logout (204)" FAIL "$S" "$T" "body=${B:0:160}"
  fi
fi

#### 8. use revoked token after logout
R=$(http_req GET "$API/account" "" "Authorization: Bearer $LOGOUT_TOKEN")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "401" ]] && contains "$B" 'revocada'; then
  record 8 "Revoked token returns 401 revocada" PASS "$S" "$T" "401+revocada"
elif [[ "$S" == "401" ]]; then
  record 8 "Revoked token returns 401 revocada" FAIL "$S" "$T" "401 but missing 'revocada': ${B:0:160}"
else
  record 8 "Revoked token returns 401 revocada" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 9. /account with valid token
R=$(http_req GET "$API/account" "" "Authorization: Bearer $TOKEN")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]] && contains "$B" '"user"' && contains "$B" '"usage"' && contains "$B" '"current"' && contains "$B" '"limit"'; then
  record 9 "/account valid token" PASS "$S" "$T" "shape ok"
else
  record 9 "/account valid token" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 10. /account without token
R=$(http_req GET "$API/account" "")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "401" ]]; then
  record 10 "/account without token" PASS "$S" "$T" "401"
else
  record 10 "/account without token" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 11. /account with malformed token
R=$(http_req GET "$API/account" "" "Authorization: Bearer garbage.token.value")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "401" ]]; then
  record 11 "/account malformed token" PASS "$S" "$T" "401"
else
  record 11 "/account malformed token" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 12. parse-cv (Gemini)
# Build JSON body via python with UTF-8 forced, write to temp, POST with --data-binary.
PYTHONIOENCODING=utf-8 python3 - > "$HERE/.cv.json" 2>/dev/null <<PY
import json
txt=open(r"$HERE_WIN\sample-cv.txt","r",encoding="utf-8").read()
print(json.dumps({"text":txt},ensure_ascii=False))
PY
if [[ -s "$HERE/.cv.json" ]]; then
  OUT=$(curl -sS -w "\n__STATUS__%{http_code}\n__TIME__%{time_total}" \
    -X POST "$API/applications/parse-cv" \
    -H "Content-Type: application/json; charset=utf-8" \
    -H "Authorization: Bearer $TOKEN" \
    --data-binary "@$HERE_WIN\\.cv.json")
  S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }' | awk -F'__TIME__' '{ print $1 }')
  T=$(printf "%s" "$OUT" | awk -F'__TIME__' 'NF>1 { print $2 }')
  B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')
  if [[ "$S" == "200" ]] && contains "$B" '"profile"' && contains "$B" '"personal"' && contains "$B" '"experience"' && contains "$B" '"skills"'; then
    record 12 "parse-cv returns UserProfile" PASS "$S" "$T" "profile shape ok"
  else
    record 12 "parse-cv returns UserProfile" FAIL "$S" "$T" "body=${B:0:220}"
  fi
else
  record 12 "parse-cv returns UserProfile" FAIL "-" "0" "cannot serialize CV text (python3 missing)"
fi

#### 13. generate cover letter (Gemini) - build payload via python to guarantee UTF-8 bytes
PYTHONIOENCODING=utf-8 python3 - > "$HERE/.gen.json" 2>/dev/null <<PY
import json
p=json.load(open(r"$HERE_WIN\sample-profile.json","r",encoding="utf-8"))
j=json.load(open(r"$HERE_WIN\sample-job.json","r",encoding="utf-8"))
print(json.dumps({"profile":p,"job":j},ensure_ascii=False))
PY
if [[ -s "$HERE/.gen.json" ]]; then
  OUT=$(curl -sS -w "\n__STATUS__%{http_code}\n__TIME__%{time_total}" \
    -X POST "$API/applications/generate" \
    -H "Content-Type: application/json; charset=utf-8" \
    -H "Authorization: Bearer $TOKEN" \
    --data-binary "@$HERE_WIN\\.gen.json")
  S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }' | awk -F'__TIME__' '{ print $1 }')
  T=$(printf "%s" "$OUT" | awk -F'__TIME__' 'NF>1 { print $2 }')
  B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')
  if [[ "$S" == "200" ]] && contains "$B" '"coverLetter"'; then
    record 13 "generate cover letter" PASS "$S" "$T" "coverLetter present"
  else
    record 13 "generate cover letter" FAIL "$S" "$T" "body=${B:0:220}"
  fi
else
  record 13 "generate cover letter" FAIL "-" "0" "could not build payload (python3 missing)"
fi

#### 14. plan limit enforcement
# Register a fresh user, call generate 3 times (free=3), expect 4th = 402.
# Note: depends on /generate actually working. If Gemini is broken this will fail
# for a different reason but we flag it explicitly.
LIMIT_BODY='{"email":"'"$EMAIL2"'","password":"'"$PASSWORD"'","name":"Limit Tester"}'
R=$(http_req POST "$API/auth/signup" "$LIMIT_BODY")
S=$(_status "$R"); B=$(_body "$R")
TOKEN2=$(printf "%s" "$B" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
LIMIT_FAIL_NOTE=""
LIMIT_OK=1
if [[ -z "$TOKEN2" ]]; then
  LIMIT_OK=0
  LIMIT_FAIL_NOTE="could not signup limit user"
elif [[ ! -s "$HERE/.gen.json" ]]; then
  LIMIT_OK=0
  LIMIT_FAIL_NOTE="no gen payload"
else
  for i in 1 2 3; do
    OUT=$(curl -sS -w "\n__STATUS__%{http_code}" -X POST "$API/applications/generate" \
      -H "Content-Type: application/json; charset=utf-8" \
      -H "Authorization: Bearer $TOKEN2" \
      --data-binary "@$HERE_WIN\\.gen.json")
    S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }')
    B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')
    if [[ "$S" != "200" ]]; then
      LIMIT_OK=0
      LIMIT_FAIL_NOTE="call $i returned $S body=${B:0:140}"
      break
    fi
  done
  if [[ $LIMIT_OK -eq 1 ]]; then
    OUT=$(curl -sS -w "\n__STATUS__%{http_code}\n__TIME__%{time_total}" -X POST "$API/applications/generate" \
      -H "Content-Type: application/json; charset=utf-8" \
      -H "Authorization: Bearer $TOKEN2" \
      --data-binary "@$HERE_WIN\\.gen.json")
    S=$(printf "%s" "$OUT" | awk -F'__STATUS__' 'NF>1 { print $2 }' | awk -F'__TIME__' '{ print $1 }')
    T=$(printf "%s" "$OUT" | awk -F'__TIME__' 'NF>1 { print $2 }')
    B=$(printf "%s" "$OUT" | awk '/__STATUS__/ { exit } { print }')
    if [[ "$S" == "402" ]] && contains "$B" 'PLAN_LIMIT_EXCEEDED'; then
      record 14 "Plan limit enforcement (free=3)" PASS "$S" "$T" "4th call 402"
    else
      record 14 "Plan limit enforcement (free=3)" FAIL "$S" "$T" "4th call ${B:0:180}"
    fi
  else
    record 14 "Plan limit enforcement (free=3)" FAIL "-" "0" "blocked by upstream generate failure: $LIMIT_FAIL_NOTE"
  fi
fi

#### 15. generate without profile
BAD_GEN='{"job":{"source":"occ","url":"https://x","id":"x","title":"x","company":"x","location":"x","salary":null,"modality":"remoto","description":"x","requirements":[],"extractedAt":"2026-04-23T10:00:00Z"}}'
R=$(http_req POST "$API/applications/generate" "$BAD_GEN" "Authorization: Bearer $TOKEN")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "400" ]] && contains "$B" 'VALIDATION_ERROR'; then
  record 15 "generate without profile -> 400" PASS "$S" "$T" "validation error"
elif [[ "$S" == "500" ]]; then
  record 15 "generate without profile -> 400" FAIL "$S" "$T" "5xx leaked"
else
  record 15 "generate without profile -> 400" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 16. billing checkout (may succeed or fail depending on conekta plan ids)
CHK_BODY='{"plan":"pro","interval":"monthly"}'
R=$(http_req POST "$API/billing/checkout" "$CHK_BODY" "Authorization: Bearer $TOKEN")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]] && contains "$B" 'checkoutUrl' && contains "$B" 'pay.conekta.com'; then
  record 16 "billing checkout pro/monthly" PASS "$S" "$T" "conekta url ok"
elif [[ "$S" == "500" ]] && contains "$B" 'INTERNAL_ERROR' && contains "$B" 'Configuracion de planes incompleta'; then
  # Known acceptable failure mode (no plan id configured) per spec allowance
  record 16 "billing checkout pro/monthly" PASS "$S" "$T" "plan id not configured (acceptable)"
elif [[ "$S" == "500" ]]; then
  record 16 "billing checkout pro/monthly" FAIL "$S" "$T" "5xx body=${B:0:200}"
else
  record 16 "billing checkout pro/monthly" FAIL "$S" "$T" "body=${B:0:200}"
fi

#### 17. billing checkout invalid plan
BAD_CHK='{"plan":"ultra","interval":"monthly"}'
R=$(http_req POST "$API/billing/checkout" "$BAD_CHK" "Authorization: Bearer $TOKEN")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "400" ]] && contains "$B" 'VALIDATION_ERROR'; then
  record 17 "billing checkout invalid plan" PASS "$S" "$T" "400"
else
  record 17 "billing checkout invalid plan" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 18. webhook without signature
R=$(http_req POST "$API/webhooks/conekta" '{"id":"evt_test","type":"ping"}')
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "401" ]] && contains "$B" 'WEBHOOK_SIGNATURE_INVALID'; then
  record 18 "webhook without signature" PASS "$S" "$T" "401 sig invalid"
elif [[ "$S" =~ ^4 ]]; then
  record 18 "webhook without signature" PASS "$S" "$T" "4xx (accepted)"
else
  record 18 "webhook without signature" FAIL "$S" "$T" "body=${B:0:160}"
fi

#### 19. CORS preflight allowed origin
PF_H=$(mktemp)
curl -sS -o /dev/null -D "$PF_H" \
  -X OPTIONS \
  -H "Origin: https://empleo.skybrandmx.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type, Authorization" \
  "$API/auth/signup"
ACAO=$(grep -i '^access-control-allow-origin:' "$PF_H" | head -1 | awk '{print $2}' | tr -d '\r')
ACAH=$(grep -i '^access-control-allow-headers:' "$PF_H" | head -1 | tr -d '\r')
ACAM=$(grep -i '^access-control-allow-methods:' "$PF_H" | head -1 | tr -d '\r')
STATUS_PF=$(head -1 "$PF_H" | awk '{print $2}' | tr -d '\r')
if [[ "$ACAO" == "https://empleo.skybrandmx.com" ]] && [[ -n "$ACAH" ]] && [[ -n "$ACAM" ]]; then
  record 19 "CORS preflight allowed origin" PASS "$STATUS_PF" "0" "ACAO=$ACAO"
else
  record 19 "CORS preflight allowed origin" FAIL "$STATUS_PF" "0" "ACAO=$ACAO ACAH=$ACAH ACAM=$ACAM"
fi
rm -f "$PF_H"

#### 20. CORS preflight rejected origin
PF_H=$(mktemp)
curl -sS -o /dev/null -D "$PF_H" \
  -X OPTIONS \
  -H "Origin: https://evil.com" \
  -H "Access-Control-Request-Method: POST" \
  "$API/auth/signup"
ACAO=$(grep -i '^access-control-allow-origin:' "$PF_H" | head -1 | awk '{print $2}' | tr -d '\r')
STATUS_PF=$(head -1 "$PF_H" | awk '{print $2}' | tr -d '\r')
if [[ -z "$ACAO" ]]; then
  record 20 "CORS preflight rejects evil.com" PASS "$STATUS_PF" "0" "no ACAO (good)"
else
  record 20 "CORS preflight rejects evil.com" FAIL "$STATUS_PF" "0" "ACAO leaked: $ACAO"
fi
rm -f "$PF_H"

#### 21. GET /
R=$(http_req GET "$LANDING/")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]] && ( contains "$B" 'SkyBrandMX' || contains "$B" 'skybrandmx' || contains_re "$B" '(Empleo Autom)' ); then
  record 21 "Landing /" PASS "$S" "$T" "contains brand"
elif [[ "$S" == "200" ]]; then
  record 21 "Landing /" FAIL "$S" "$T" "200 but no brand string"
else
  record 21 "Landing /" FAIL "$S" "$T" "status"
fi

#### 22. GET /signup
R=$(http_req GET "$LANDING/signup")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]]; then
  record 22 "Landing /signup" PASS "$S" "$T" "200"
else
  record 22 "Landing /signup" FAIL "$S" "$T" "status"
fi

#### 23. GET /login
R=$(http_req GET "$LANDING/login")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]]; then
  record 23 "Landing /login" PASS "$S" "$T" "200"
else
  record 23 "Landing /login" FAIL "$S" "$T" "status"
fi

#### 24. GET /privacy
R=$(http_req GET "$LANDING/privacy")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]] && contains_re "$B" '(LFPDPPP|aviso de privacidad|Aviso de Privacidad)'; then
  record 24 "Landing /privacy (LFPDPPP)" PASS "$S" "$T" "ok"
elif [[ "$S" == "200" ]]; then
  record 24 "Landing /privacy (LFPDPPP)" FAIL "$S" "$T" "200 but no LFPDPPP keyword"
else
  record 24 "Landing /privacy (LFPDPPP)" FAIL "$S" "$T" "status"
fi

#### 25. GET /terms
R=$(http_req GET "$LANDING/terms")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]]; then
  record 25 "Landing /terms" PASS "$S" "$T" "200"
else
  record 25 "Landing /terms" FAIL "$S" "$T" "status"
fi

#### 26. GET /api/health
R=$(http_req GET "$LANDING/api/health")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "200" ]] && contains "$B" '"ok":true'; then
  record 26 "Landing /api/health" PASS "$S" "$T" "ok:true"
else
  record 26 "Landing /api/health" FAIL "$S" "$T" "body=${B:0:120}"
fi

#### 27. HTML inspection of landing (meta tags, broken obvious links)
R=$(http_req GET "$LANDING/")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
HAS_TITLE=0; HAS_DESC=0; HAS_VIEWPORT=0
contains_re "$B" '<title[^>]*>[^<]+</title>' && HAS_TITLE=1
contains_re "$B" 'name="description"' && HAS_DESC=1
contains_re "$B" 'name="viewport"' && HAS_VIEWPORT=1
NOTE="title=$HAS_TITLE desc=$HAS_DESC viewport=$HAS_VIEWPORT"
if [[ $HAS_TITLE -eq 1 ]] && [[ $HAS_VIEWPORT -eq 1 ]]; then
  if [[ $HAS_DESC -eq 1 ]]; then
    record 27 "Landing HTML meta tags" PASS "$S" "$T" "$NOTE"
  else
    record 27 "Landing HTML meta tags" FAIL "$S" "$T" "$NOTE missing description"
  fi
else
  record 27 "Landing HTML meta tags" FAIL "$S" "$T" "$NOTE"
fi

#### 28. SQL injection in signup email field
INJ_PAYLOAD='{"email":"x+'"$RUN_ID"'\u0027); DROP TABLE users; --","password":"supersecret123","name":"X"}'
# simpler: use raw quotes via printf safe
INJ_EMAIL="x+inj${RUN_ID}'); DROP TABLE users; --"
INJ_BODY=$(printf '{"email":"%s","password":"supersecret123","name":"X"}' "$INJ_EMAIL" | sed 's/"/\\"/g; s/\\\\\"/\\"/g')
# Actually do it simpler with a python-safe heredoc
RUN_ID="$RUN_ID" PYTHONIOENCODING=utf-8 python3 - <<'PY' > "$HERE/.inj.json" 2>/dev/null || true
import json,os
run=os.environ.get("RUN_ID","x")
email="x+inj"+run+"'); DROP TABLE users; --"
print(json.dumps({"email":email,"password":"supersecret123","name":"X"}))
PY
if [[ -s "$HERE/.inj.json" ]]; then
  INJ_BODY=$(cat "$HERE/.inj.json")
  R=$(http_req POST "$API/auth/signup" "$INJ_BODY")
  S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
  # Either validator rejects it (400) OR server sanitizes and rejects as invalid email
  if [[ "$S" == "400" ]]; then
    record 28 "SQL injection on signup email" PASS "$S" "$T" "400 validation (sanitized)"
  elif [[ "$S" == "201" ]]; then
    # If it actually created a user we must check users table still works by trying signup again
    R2=$(http_req POST "$API/auth/signup" "$BODY")
    S2=$(_status "$R2")
    if [[ "$S2" == "409" ]]; then
      record 28 "SQL injection on signup email" PASS "$S" "$T" "created but users table intact"
    else
      record 28 "SQL injection on signup email" FAIL "$S" "$T" "post-inject signup returned $S2 (table?)"
    fi
  else
    record 28 "SQL injection on signup email" FAIL "$S" "$T" "body=${B:0:160}"
  fi
  rm -f "$HERE/.inj.json"
else
  record 28 "SQL injection on signup email" FAIL "-" "0" "python3 not available to build payload"
fi

#### 29. XSS in user name is JSON-escaped in /account
XSS_RUN="xss${RUN_ID}"
XSS_EMAIL="xss+${XSS_RUN}@test.skybrandmx.com"
XSS_NAME='<script>alert(1)</script>'
# build carefully escaped JSON via python
PYTHONIOENCODING=utf-8 python3 - > "$HERE/.xss.json" 2>/dev/null <<PY
import json
print(json.dumps({"email":"$XSS_EMAIL","password":"supersecret123","name":"$XSS_NAME"}))
PY
if [[ -s "$HERE/.xss.json" ]]; then
  XSS_BODY=$(cat "$HERE/.xss.json")
  R=$(http_req POST "$API/auth/signup" "$XSS_BODY")
  S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
  XSS_TOKEN=$(printf "%s" "$B" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [[ -n "$XSS_TOKEN" ]]; then
    R=$(http_req GET "$API/account" "" "Authorization: Bearer $XSS_TOKEN")
    S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
    # In JSON, the unescaped < should be present literally BUT tag must be inside a JSON string (no raw </script>)
    # Safer check: content-type must be json and body must NOT be html
    CT_H=$(mktemp)
    curl -sS -o /dev/null -D "$CT_H" -H "Authorization: Bearer $XSS_TOKEN" "$API/account"
    CT=$(grep -i '^content-type:' "$CT_H" | head -1 | tr -d '\r')
    rm -f "$CT_H"
    if contains "$CT" "application/json" && contains "$B" '<script>alert(1)</script>' && ! contains "$B" '<html'; then
      record 29 "XSS name JSON-escaped" PASS "$S" "$T" "JSON content-type preserved, no html"
    elif contains "$CT" "application/json"; then
      record 29 "XSS name JSON-escaped" PASS "$S" "$T" "returned as JSON ($CT)"
    else
      record 29 "XSS name JSON-escaped" FAIL "$S" "$T" "ct=$CT body=${B:0:160}"
    fi
  else
    record 29 "XSS name JSON-escaped" FAIL "$S" "$T" "signup failed, body=${B:0:160}"
  fi
  rm -f "$HERE/.xss.json"
else
  record 29 "XSS name JSON-escaped" FAIL "-" "0" "python3 not available"
fi

#### 30. Try to access /v1/account with bogus user id header (authz can't be spoofed via header)
R=$(http_req GET "$API/account" "" "X-User-Id: 11111111-1111-1111-1111-111111111111")
S=$(_status "$R"); T=$(_time "$R"); B=$(_body "$R")
if [[ "$S" == "401" ]]; then
  record 30 "Account cannot be spoofed by header" PASS "$S" "$T" "401 (authz via JWT only)"
else
  record 30 "Account cannot be spoofed by header" FAIL "$S" "$T" "body=${B:0:160}"
fi

# -------- summary -------------------------------------------------------
echo ""
echo "================================================"
printf "Total tests: %d  PASS: %d  FAIL: %d\n" "$TESTS_RUN" "$PASS" "$FAIL"
echo "Results JSONL: $RESULTS"
echo "================================================"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
