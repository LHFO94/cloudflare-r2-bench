#!/usr/bin/env python3
"""Prove the R2 S3 credentials work, and that they can read the benchmark buckets.

Shape-checking the keys is not enough. Wrong or unscoped credentials let every
VM boot cleanly and then 403 on every single request, which surfaces as "0 RPS"
with no obvious cause and a fleet you have to tear down to investigate. Ten
seconds here saves that.

Stdlib only, because the harness deliberately has no Python dependencies.
Usage: check_r2_creds.py <account_id> <bucket> [bucket ...]
"""
import datetime
import hashlib
import hmac
import subprocess
import sys

REGION, SERVICE = "auto", "s3"


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def signed_get(host: str, path: str, query: str, ak: str, sk: str):
    """GET an R2 path with SigV4. Returns (status, body)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()

    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical = (
        f"GET\n{path}\n{query}\n"
        f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amzdate}\n\n"
        f"{signed_headers}\n{payload_hash}"
    )
    scope = f"{datestamp}/{REGION}/{SERVICE}/aws4_request"
    to_sign = (
        "AWS4-HMAC-SHA256\n"
        f"{amzdate}\n{scope}\n"
        f"{hashlib.sha256(canonical.encode()).hexdigest()}"
    )

    k = _sign(f"AWS4{sk}".encode(), datestamp)
    for part in (REGION, SERVICE, "aws4_request"):
        k = _sign(k, part)
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()

    url = f"https://{host}{path}" + (f"?{query}" if query else "")
    auth = (
        f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    # Sign here, but send with curl. Python's ssl module uses its own CA bundle
    # and rejects TLS-intercepting corporate proxies ("CA cert does not include
    # key usage extension"), whereas curl uses the system trust store and works.
    # Everything else in preflight already goes through curl, so this keeps the
    # network behaviour consistent.
    try:
        p = subprocess.run(
            [
                "curl", "-s", "--max-time", "20",
                "-o", "-", "-w", "\n%{http_code}",
                "-H", f"x-amz-date: {amzdate}",
                "-H", f"x-amz-content-sha256: {payload_hash}",
                "-H", f"Authorization: {auth}",
                url,
            ],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        return 0, str(e)

    if p.returncode != 0:
        return 0, (p.stderr.strip() or f"curl exit {p.returncode}")

    body, _, code = p.stdout.rpartition("\n")
    try:
        return int(code), body
    except ValueError:
        return 0, "could not parse curl response"


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: check_r2_creds.py <account_id> <bucket> [bucket ...]")
        return 2

    account, buckets = sys.argv[1], sys.argv[2:]
    import os

    ak = os.environ.get("TF_VAR_r2_access_key_id", "")
    sk = os.environ.get("TF_VAR_r2_secret_access_key", "")
    if not ak or not sk or "pending" in (ak, sk):
        print("SKIP R2 keys not set")
        return 0

    host = f"{account}.r2.cloudflarestorage.com"
    failed = False

    for b in buckets:
        # max-keys=1: cheapest possible proof of read access.
        status, body = signed_get(host, f"/{b}", "max-keys=1", ak, sk)
        if status == 200:
            print(f"OK   can read {b}")
        elif status == 0:
            print(f"FAIL {b}: {body}")
            failed = True
        else:
            code = ""
            if "<Code>" in body:
                code = body.split("<Code>")[1].split("</Code>")[0]
            hint = ""
            if status == 403:
                # The overwhelmingly likely cause, given the two-phase setup.
                hint = "  (token not scoped to this bucket, or wrong secret)"
            elif status == 404:
                hint = "  (bucket does not exist - run: make tf-apply-r2)"
            print(f"FAIL {b}: HTTP {status} {code}{hint}")
            failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
