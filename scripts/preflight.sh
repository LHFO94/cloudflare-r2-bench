#!/usr/bin/env bash
#
# Check every credential and prerequisite before `terraform apply`.
#
# Exists because the failure modes here are slow and expensive to discover:
# an apply that gets halfway through Cloudflare and then dies on GCP leaves
# real buckets behind, and R2 remembers a bucket name's location forever. Each
# check below corresponds to a mistake that has actually happened.
set -uo pipefail

FAIL=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=1; }

echo
echo "Cloudflare"

TFVARS="terraform/envs/${ENV:-smoke}/terraform.tfvars"
[[ -f "$TFVARS" ]] || TFVARS=$(ls terraform/envs/*/terraform.tfvars 2>/dev/null | head -1)

ACCOUNT_ID=$(grep -hoE '"?cloudflare_account_id"?[[:space:]]*=[[:space:]]*"[0-9a-f]+"' \
  "$TFVARS" 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
DEPLOYMENT_ID=$(grep -hoE '"?deployment_id"?[[:space:]]*=[[:space:]]*"[^"]+"' \
  "$TFVARS" 2>/dev/null | sed -E 's/.*"([^"]+)"$/\1/' | head -1)

cf() {  # cf <path> -> body on stdout
  curl -s --max-time 15 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/$1" 2>/dev/null
}

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  bad "CLOUDFLARE_API_TOKEN is not set. Put it in .env (see .env.example)."
elif [[ -z "${ACCOUNT_ID:-}" ]]; then
  bad "no cloudflare_account_id found in terraform/envs/*/terraform.tfvars"
else
  # A 64-hex value is the single most common mix-up: the R2 token screen shows
  # the S3 secret access key right next to the API token, and only one of them
  # works against api.cloudflare.com.
  if [[ "$CLOUDFLARE_API_TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
    bad "CLOUDFLARE_API_TOKEN looks like a 64-hex R2 secret access key, not an API token (~40 chars)."
  fi

  # Tokens come in two flavours and they verify at different endpoints:
  # user-owned at /user/tokens/verify, account-owned at
  # /accounts/<id>/tokens/verify. A perfectly good account-owned token returns
  # "Invalid API Token" from the user endpoint, so try both before believing it.
  status=$(
    for p in "accounts/$ACCOUNT_ID/tokens/verify" "user/tokens/verify"; do
      cf "$p" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
r=d.get("result") or {}
if r.get("status")=="active": print(r.get("status","active"), r.get("expires_on") or "never"); sys.exit(0)
sys.exit(1)' 2>/dev/null && break
    done
  )

  if [[ -n "$status" ]]; then
    expires=${status#* }
    ok "API token is active"
    if [[ "$expires" != "never" ]]; then
      # Terraform will fail mid-apply if this lapses during a long run.
      days=$(python3 -c "
import datetime,sys
try:
    e=datetime.datetime.fromisoformat('$expires'.replace('Z','+00:00'))
    print((e-datetime.datetime.now(datetime.timezone.utc)).days)
except Exception: print(999)" 2>/dev/null)
      if [[ "$days" -lt 14 ]]; then
        warn "token expires in $days days ($expires)"
      else
        ok "token expires $expires"
      fi
    fi
  else
    bad "API token rejected by both the account and user verify endpoints"
  fi

  # Verify each permission the stack actually needs, rather than trusting the
  # token's self-description. Wrong-scope tokens otherwise fail mid-apply.
  #
  # Parse the JSON rather than grepping it: the API pretty-prints larger
  # responses, so a substring test for '"success":true' reports a false failure
  # on any account with enough Workers scripts to push the body over the limit.
  probe() {  # probe <label> <path>
    local out
    out=$(cf "$2" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("unparseable response"); sys.exit(1)
if d.get("success"): sys.exit(0)
errs=d.get("errors") or [{}]
print(errs[0].get("message","unknown error")); sys.exit(1)' 2>/dev/null)
    if [[ $? -eq 0 ]]; then
      ok "can $1"
    else
      bad "cannot $1 - ${out:-request failed}"
    fi
  }
  probe "list R2 buckets (Workers R2 Storage:Edit)" "accounts/$ACCOUNT_ID/r2/buckets"
  probe "list D1 databases (D1:Edit)"               "accounts/$ACCOUNT_ID/d1/database"
  probe "list Workers scripts (Workers Scripts:Edit)" "accounts/$ACCOUNT_ID/workers/scripts"
fi

echo
echo "R2 S3 credentials"

# Only warn: these are not needed for `make tf-apply-r2`, which is the step
# that creates the buckets you scope the token to.
if [[ -z "${TF_VAR_r2_access_key_id:-}" || "$TF_VAR_r2_access_key_id" == "pending" ]]; then
  warn "TF_VAR_r2_access_key_id unset - fine for tf-apply-r2, required for the full apply"
elif [[ ! "$TF_VAR_r2_access_key_id" =~ ^[0-9a-f]{32}$ ]]; then
  warn "TF_VAR_r2_access_key_id is not 32 hex characters - is this the access key id?"
else
  ok "access key id looks well formed"
fi

if [[ -z "${TF_VAR_r2_secret_access_key:-}" || "$TF_VAR_r2_secret_access_key" == "pending" ]]; then
  warn "TF_VAR_r2_secret_access_key unset - fine for tf-apply-r2, required for the full apply"
elif [[ ! "$TF_VAR_r2_secret_access_key" =~ ^[0-9a-f]{64}$ ]]; then
  warn "TF_VAR_r2_secret_access_key is not 64 hex characters"
else
  ok "secret access key looks well formed"
fi

# Well-formed is not the same as working. Actually sign a request against each
# bucket: wrong or badly-scoped keys otherwise let the whole fleet boot and 403
# on every request, which looks like "0 RPS" and nothing else.
if [[ -n "${ACCOUNT_ID:-}" && -n "${DEPLOYMENT_ID:-}" && -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  # Newline-separated string rather than an array: macOS ships bash 3.2, which
  # has no `mapfile`, and errors on ${#arr[@]} for an empty array under `set -u`.
  # Bucket names cannot contain spaces, so word splitting below is safe.
  # The endpoint pages at 20 and this account has unrelated buckets that sort
  # ahead of r2bench-*, so a single call checked only the first ten and
  # reported all-green. Follow the cursor; a partial check that looks complete
  # is worse than no check.
  CURSOR=""
  BUCKET_LIST=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    PAGE_PATH="accounts/$ACCOUNT_ID/r2/buckets?per_page=1000"
    [[ -n "$CURSOR" ]] && PAGE_PATH="$PAGE_PATH&cursor=$CURSOR"
    # First line is the next cursor (url-encoded, empty when exhausted); the
    # rest are matching bucket names.
    PAGE=$(cf "$PAGE_PATH" | python3 -c "
import json,sys,urllib.parse
try: d=json.load(sys.stdin)
except Exception:
    print(); sys.exit(0)
print(urllib.parse.quote((d.get('result_info') or {}).get('cursor') or '', safe=''))
for b in (d.get('result') or {}).get('buckets') or []:
    if b.get('name','').startswith('r2bench-$DEPLOYMENT_ID-'): print(b['name'])
" 2>/dev/null)
    CURSOR=$(printf '%s\n' "$PAGE" | head -1)
    NAMES=$(printf '%s\n' "$PAGE" | tail -n +2)
    [[ -n "$NAMES" ]] && BUCKET_LIST=$(printf '%s\n%s' "$BUCKET_LIST" "$NAMES")
    [[ -z "$CURSOR" ]] && break
  done
  BUCKET_LIST=$(printf '%s\n' "$BUCKET_LIST" | grep -v '^$' || true)

  if [[ -z "$BUCKET_LIST" ]]; then
    warn "no r2bench-$DEPLOYMENT_ID-* buckets yet - run: make tf-apply-r2"
  else
    # Capture once, then iterate with a here-string: piping into `while` would
    # run the loop in a subshell, where updates to FAIL would be discarded.
    R2_OUT=$(python3 scripts/check_r2_creds.py "$ACCOUNT_ID" $BUCKET_LIST)
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      case "$line" in
        OK*)   ok   "${line#OK   }" ;;
        SKIP*) warn "${line#SKIP }" ;;
        *)     bad  "${line#FAIL }" ;;
      esac
    done <<< "$R2_OUT"
  fi
fi

echo
echo "GCP"

if ! command -v gcloud >/dev/null 2>&1; then
  bad "gcloud not on PATH"
else
  # Terraform's Google provider uses Application Default Credentials, which are
  # a completely separate identity from `gcloud config set account`. Having the
  # right gcloud account and the wrong ADC is silent until apply fails.
  adc_token=$(gcloud auth application-default print-access-token 2>/dev/null)
  if [[ -z "$adc_token" ]]; then
    bad "no Application Default Credentials. Run: gcloud auth application-default login"
  else
    adc_email=$(curl -s --max-time 15 "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=$adc_token" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("email",""))' 2>/dev/null)
    project="${CLOUDSDK_CORE_PROJECT:-}"

    if [[ -z "$project" ]]; then
      warn "CLOUDSDK_CORE_PROJECT unset - cannot check that ADC reaches the project"
      probe=""
    else
      probe=$(curl -s --max-time 15 -H "Authorization: Bearer $adc_token" \
        "https://compute.googleapis.com/compute/v1/projects/$project" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("name") or "ERR:"+d.get("error",{}).get("message","unknown"))' 2>/dev/null)
    fi

    if [[ -z "$project" ]]; then
      : # already warned
    elif [[ "$probe" == ERR:* ]]; then
      bad "ADC identity <$adc_email> cannot reach $project: ${probe#ERR:}"
      echo "        Fix: gcloud auth application-default login   (choose the right account)"
    else
      ok "ADC identity <$adc_email> can reach $project"
    fi
  fi
fi

echo
echo "Build artifacts"

if [[ -f dist/agent-linux-amd64 ]]; then
  if [[ -n $(find cmd/agent internal -name '*.go' -newer dist/agent-linux-amd64 2>/dev/null) ]]; then
    warn "dist/agent-linux-amd64 is older than the Go sources - run: make build-agent"
  else
    ok "agent binary is current"
  fi
else
  bad "dist/agent-linux-amd64 missing - run: make build-agent"
fi

echo
if [[ $FAIL -ne 0 ]]; then
  echo "preflight FAILED - fix the items above before applying"
  exit 1
fi
echo "preflight passed"
