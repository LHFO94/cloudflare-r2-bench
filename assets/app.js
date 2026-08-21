/**
 * Shared API helper for the operator UI.
 *
 * The control plane protects /api/v1/* with an admin token. Open any page with
 * ?token=<ADMIN_TOKEN> once; the token is stripped from the address bar so it
 * does not end up in bookmarks, screenshots or the browser history.
 *
 * Stored in localStorage rather than sessionStorage. sessionStorage is dropped
 * when the tab closes, which meant every new tab dead-ended on a 401 telling
 * the operator to reconstruct a URL it did not give them. This is a disposable
 * benchmark control plane, so surviving a tab close is worth more than the
 * marginal hardening. Use the browser's clear-site-data to sign out.
 */
const TOKEN_KEY = "r2bench.adminToken";

(function captureTokenFromUrl() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (token === null) {
        return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
})();

function adminToken() {
    return localStorage.getItem(TOKEN_KEY) ?? "";
}

/**
 * Call the control plane and return the parsed body.
 *
 * Throws on a non-2xx response so callers do not have to check both the HTTP
 * status and the payload's own status field.
 */
async function api(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    const token = adminToken();
    if (token) {
        headers["x-admin-token"] = token;
    }
    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    const response = await fetch(path, {
        ...options,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let data = null;
    try {
        data = await response.json();
    } catch {
        // Non-JSON error page; fall through to the status-based message.
    }

    if (response.status === 401) {
        // A stale token is as likely as a missing one, so clear it rather than
        // leaving the operator stuck behind a credential that cannot work.
        localStorage.removeItem(TOKEN_KEY);
        throw new Error(
            "Unauthorized. Run `make dashboard` (or `terraform output -raw dashboard_url`) " +
            "and open the URL it prints - it includes the admin token.",
        );
    }
    if (!response.ok) {
        throw new Error(data?.message ?? `Request failed with status ${response.status}`);
    }
    return data;
}
