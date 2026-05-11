/**
 * Minimal authenticated smoke checks for portal-critical GET routes.
 *
 * Usage:
 *   PORTAL_SMOKE_TOKEN="<jwt>" PORTAL_SMOKE_BASE_URL="http://localhost:4000/api" node scripts/portal-smoke.js
 *
 * If PORTAL_SMOKE_TOKEN is unset, exits 0 after printing a skip message (CI should set the token).
 */
/* eslint-disable no-console */

const base = (process.env.PORTAL_SMOKE_BASE_URL || "http://localhost:4000/api").replace(/\/$/, "");
const token = process.env.PORTAL_SMOKE_TOKEN || "";

async function get(path) {
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const rid = res.headers.get("x-request-id");
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  return { path, status: res.status, rid, bodySnippet: bodyText.slice(0, 200) };
}

async function main() {
  if (!token) {
    console.log("[portal-smoke] PORTAL_SMOKE_TOKEN not set — skipping authenticated checks.");
    process.exit(0);
  }

  const checks = [
    ["/process/view", "Process view (planning-related read list)"],
    ["/planing/view", "Planning view"],
    ["/getOverallDeviceTestEntry?page=1&limit=5&mode=ngportal", "NG portal device test entries"],
  ];

  let failed = false;
  for (const [path, label] of checks) {
    const r = await get(path);
    const ok = r.status >= 200 && r.status < 300;
    console.log(
      `[portal-smoke] ${ok ? "OK" : "FAIL"} ${label} ${path} -> ${r.status} requestId=${r.rid || "-"}`
    );
    if (!ok) {
      console.error(`  body: ${r.bodySnippet}`);
      failed = true;
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[portal-smoke] error:", e);
  process.exit(1);
});
