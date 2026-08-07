#!/bin/bash
# verify.sh — Post-deploy verification for Dispatch HUD
# Run after deploy to catch issues before the user checks.
# Exits non-zero on any failure.

set -euo pipefail
HOST="${1:-http://127.0.0.1:4400}"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "=== Dispatch HUD Verification ==="
echo "Host: $HOST"
echo ""

# 1. Server responds with HTTP 200
echo "--- Server health ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HOST/" 2>/dev/null || true)
if [ "$HTTP_CODE" = "200" ]; then
  pass "HTTP 200 OK"
else
  fail "HTTP $HTTP_CODE (expected 200)"
fi

# 2. HTML contains closing tags and DISPATCH
echo "--- HTML structure ---"
HTML=$(curl -s --max-time 5 "$HOST/" 2>/dev/null || true)
if echo "$HTML" | grep -q '</html>'; then
  pass "Has </html>"
else
  fail "Missing </html>"
fi
if echo "$HTML" | grep -qi 'dispatch'; then
  pass "Contains Dispatch text"
else
  fail "Missing Dispatch text"
fi

# 3. Client-side JavaScript is syntactically valid
echo "--- Client JS syntax ---"
# Extract script blocks and validate each
JS_RESULT=$(echo "$HTML" | python3 -c "
import sys, re
h = sys.stdin.read()
scripts = re.findall(r'<script>(.*?)</script>', h, re.DOTALL)
if not scripts:
    print('NO_SCRIPT')
else:
    for i, s in enumerate(scripts):
        print(f'SCRIPT_{i}:{len(s)}bytes')
" 2>/dev/null || true)
if echo "$JS_RESULT" | grep -q 'NO_SCRIPT'; then
  fail "No script block found in HTML"
elif echo "$JS_RESULT" | grep -q 'SCRIPT_'; then
  # Write each script to a temp file and check syntax
  echo "$HTML" | python3 -c "
import sys, re
h = sys.stdin.read()
scripts = re.findall(r'<script>(.*?)</script>', h, re.DOTALL)
for i, s in enumerate(scripts):
    with open(f'/tmp/hud-js-check-{i}.js', 'w') as f:
        f.write(s)
" 2>/dev/null
  JS_ERRORS=0
  for f in /tmp/hud-js-check-*.js; do
    if ! node --check "$f" 2>/dev/null; then
      JS_ERRORS=$((JS_ERRORS+1))
    fi
  done
  rm -f /tmp/hud-js-check-*.js
  if [ "$JS_ERRORS" -eq 0 ]; then
    pass "Client JS syntax valid"
  else
    fail "Client JS syntax error in $JS_ERRORS script block(s)"
  fi
else
  fail "Could not extract script blocks"
fi

# 4. SSE stream delivers data AND is complete, parseable JSON
echo "--- SSE stream ---"
SSE=$(curl -s --no-buffer --max-time 8 "$HOST/stream" 2>/dev/null || true)
if echo "$SSE" | grep -q 'event: state'; then
  pass "SSE stream delivers state events"
else
  fail "SSE stream missing state events"
fi

# Extract the data payload and verify it parses as complete JSON
SSE_JSON=$(echo "$SSE" | python3 -c "
import sys, re, json
data = sys.stdin.read()
# Find the first complete data: line
for line in data.split('\n'):
    if line.startswith('data: '):
        payload = line[6:]
        try:
            parsed = json.loads(payload)
            print('OK:' + str(len(parsed.get('agents',[]))) + ' agents')
        except json.JSONDecodeError as e:
            print('JSON_ERROR:' + str(e))
        break
" 2>/dev/null || true)
if echo "$SSE_JSON" | grep -q '^OK:'; then
  AGENT_COUNT=$(echo "$SSE_JSON" | sed 's/^OK://;s/ agents//')
  pass "SSE data payload parses as valid JSON ($AGENT_COUNT agents)"
  if [ "$AGENT_COUNT" -ge 5 ]; then
    pass "Agent count >= 5 ($AGENT_COUNT)"
  else
    fail "Agent count too low ($AGENT_COUNT, expected >= 5)"
  fi
else
  fail "SSE data payload does not parse as valid JSON: $SSE_JSON"
fi

# 5. State contains real agents
echo "--- Data quality ---"
if echo "$SSE" | grep -q '"agents"'; then
  pass "State has agents array"
else
  fail "State missing agents array"
fi
if echo "$SSE" | grep -q '"main"'; then
  pass "Contains main agent"
else
  fail "Missing main agent"
fi
if echo "$SSE" | grep -q '"sessions"'; then
  pass "State has sessions array"
else
  fail "State missing sessions array"
fi

# 6. No offline event
echo "--- No error states ---"
if echo "$SSE" | grep -q 'gateway-offline'; then
  fail "Gateway reported as offline"
else
  pass "Gateway is online"
fi

echo ""
echo "=== Results: $PASS pass, $FAIL fail ==="
[ "$FAIL" -eq 0 ] || exit 1