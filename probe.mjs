#!/usr/bin/env node
/* Kattenberg 118 — external prober (FASE 2)
 *
 * Runs from GitHub Actions (off-NAS) every ~5 min. For each public service it
 * does an HTTP check and records status + http_code + latency + timestamp.
 *
 * State (previous status, consecutive-fail counter, uptime ring buffer) is
 * carried INSIDE status.json on the `status-data` branch, which the workflow
 * checks out into ./_data before this runs. That keeps everything in one file
 * and avoids any extra storage.
 *
 * Debounce: a service is only reported "down" after DOWN_THRESHOLD consecutive
 * failed checks, so a single blip never flips the public page or fires a mail.
 *
 * On a real state transition (up <-> down) it sends a Resend email — but only
 * when RESEND_API_KEY is present, so the probe itself never fails if alerting
 * isn't configured yet.
 *
 * No secrets are ever printed. */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---- config -----------------------------------------------------------------

const SERVICES = [
  { id: "dkwb",    name: "De Kleine Wereldburger", url: "https://dekleinewereldburger.be" },
  { id: "www",     name: "Kattenberg 118",          url: "https://www.kattenberg118.be" },
  { id: "studio",  name: "Studio",                  url: "https://studio.kattenberg118.be" },
  { id: "umami",   name: "Analytics (Umami)",       url: "https://umami.kattenberg118.be" },
];

const DOWN_THRESHOLD   = 3;     // consecutive failures before we call it "down"
const TIMEOUT_MS       = 15000; // per-request timeout
const SLOW_MS          = 4000;  // above this (but OK) => "degraded"
const UPTIME_WINDOW    = 288;   // ~24h of samples at 5-min cadence
const RETRIES          = 1;     // quick in-run retry to dampen transient TCP resets

const DATA_PATH  = process.env.STATUS_DATA_PATH  || "_data/status.json";
const OUT_PATH   = process.env.STATUS_OUT_PATH   || "status.json";

const ALERT_TO   = process.env.ALERT_EMAIL_TO   || "contact@jonassmets.net";
const ALERT_FROM = process.env.ALERT_EMAIL_FROM || "Kattenberg 118 status <status@kattenberg118.be>";
const RESEND_KEY = process.env.RESEND_API_KEY    || "";
const PUBLIC_URL = process.env.STATUS_PUBLIC_URL || "https://status.kattenberg118.be";

// ---- helpers ----------------------------------------------------------------

function loadPrevious() {
  try {
    if (existsSync(DATA_PATH)) {
      const json = JSON.parse(readFileSync(DATA_PATH, "utf8"));
      const map = {};
      (json.services || []).forEach((s) => { map[s.id] = s; });
      return map;
    }
  } catch (e) {
    console.warn("could not parse previous status.json, starting fresh:", e.message);
  }
  return {};
}

async function checkOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "kattenberg118-status-probe/1.0 (+https://status.kattenberg118.be)" },
    });
    // drain body so the connection closes cleanly and latency reflects full TTFB+
    await res.arrayBuffer().catch(() => {});
    const latency = Date.now() - started;
    return { ok: res.status >= 200 && res.status < 400, http_code: res.status, latency_ms: latency };
  } catch (err) {
    const latency = Date.now() - started;
    return { ok: false, http_code: 0, latency_ms: latency, error: err.name || "error" };
  } finally {
    clearTimeout(timer);
  }
}

async function check(url) {
  let last = await checkOnce(url);
  for (let i = 0; i < RETRIES && !last.ok; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    last = await checkOnce(url);
  }
  return last;
}

function pushUptime(history, healthy) {
  const arr = Array.isArray(history) ? history.slice(-(UPTIME_WINDOW - 1)) : [];
  arr.push(healthy ? 1 : 0);
  return arr;
}

function uptimePct(history) {
  if (!history || history.length === 0) return 100;
  const sum = history.reduce((a, b) => a + b, 0);
  return Math.round((sum / history.length) * 1000) / 10;
}

// ---- alerting ---------------------------------------------------------------

async function sendAlert(transitions) {
  if (!RESEND_KEY) {
    console.log(`[alert] ${transitions.length} transition(s) but RESEND_API_KEY not set — skipping email.`);
    return;
  }

  const anyDown = transitions.some((t) => t.to === "down");
  const subject = anyDown
    ? `🔴 Storing: ${transitions.filter((t) => t.to === "down").map((t) => t.name).join(", ")}`
    : `🟢 Hersteld: ${transitions.filter((t) => t.to === "up").map((t) => t.name).join(", ")}`;

  const lines = transitions.map((t) => {
    const icon = t.to === "down" ? "🔴" : "🟢";
    const what = t.to === "down" ? "is onbereikbaar" : "is weer operationeel";
    const detail = t.to === "down"
      ? (t.http_code ? `HTTP ${t.http_code}` : "geen verbinding")
      : `${t.http_code ? "HTTP " + t.http_code : ""}${t.latency_ms != null ? " · " + t.latency_ms + " ms" : ""}`;
    return `${icon} ${t.name} ${what} — ${t.url}${detail ? " (" + detail.trim() + ")" : ""}`;
  });

  const text =
    `Kattenberg 118 — statuswijziging\n\n` +
    lines.join("\n") +
    `\n\nTijd: ${new Date().toLocaleString("nl-BE", { timeZone: "Europe/Brussels" })}\n` +
    `Statuspagina: ${PUBLIC_URL}\n`;

  const rows = transitions.map((t) => {
    const down = t.to === "down";
    const color = down ? "#d6492a" : "#5f9c79";
    const what = down ? "is onbereikbaar" : "is weer operationeel";
    const detail = down
      ? (t.http_code ? `HTTP ${t.http_code}` : "geen verbinding")
      : `${t.http_code ? "HTTP " + t.http_code : "OK"}${t.latency_ms != null ? " · " + t.latency_ms + " ms" : ""}`;
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:8px;"></span>
        <strong style="color:#3d2d33;">${t.name}</strong> ${what}<br>
        <span style="color:#8a8079;font-size:13px;">${t.url} · ${detail}</span>
      </td></tr>`;
  }).join("");

  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;background:#efe9dd;padding:28px 16px;">
      <div style="max-width:520px;margin:0 auto;background:#fffff7;border-radius:16px;overflow:hidden;border:1px solid rgba(61,45,51,0.1);">
        <div style="padding:20px 22px;border-bottom:1px solid rgba(61,45,51,0.08);">
          <div style="font-weight:700;color:#3d2d33;font-size:16px;">Kattenberg 118 — statuswijziging</div>
        </div>
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <div style="padding:16px 22px;color:#8a8079;font-size:13px;">
          ${new Date().toLocaleString("nl-BE", { timeZone: "Europe/Brussels" })} ·
          <a href="${PUBLIC_URL}" style="color:#3d2d33;">Bekijk de statuspagina</a>
        </div>
      </div>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // body may contain an error message but never the key
      console.error(`[alert] Resend returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    } else {
      console.log(`[alert] email sent (${transitions.length} transition(s)).`);
    }
  } catch (e) {
    console.error("[alert] failed to call Resend:", e.message);
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const prev = loadPrevious();
  const now = new Date().toISOString();
  const transitions = [];

  const results = await Promise.all(
    SERVICES.map(async (svc, idx) => {
      const p = prev[svc.id] || {};
      const r = await check(svc.url);

      const healthy = r.ok;
      let failCount = p.consecutive_fails || 0;
      failCount = healthy ? 0 : failCount + 1;

      // previous *reported* state (defaults to "up" on first ever run so we
      // don't fire a spurious "down" before we have evidence)
      const prevReported = p.status === "down" ? "down" : "up";

      // effective state with debounce applied
      let reported;
      if (healthy) {
        reported = r.latency_ms > SLOW_MS ? "degraded" : "up";
      } else if (failCount >= DOWN_THRESHOLD) {
        reported = "down";
      } else {
        // failing but under threshold — hold previous non-up appearance soft:
        // keep showing the last good-ish state but mark degraded to hint trouble
        reported = prevReported === "down" ? "down" : "degraded";
      }

      const history = pushUptime(p.uptime_history, healthy);

      // transition detection on the hard up<->down boundary only
      const wasDown = prevReported === "down";
      const isDown = reported === "down";
      if (isDown && !wasDown) {
        transitions.push({ id: svc.id, name: svc.name, url: svc.url, to: "down", http_code: r.http_code, latency_ms: r.latency_ms });
      } else if (!isDown && wasDown && healthy) {
        transitions.push({ id: svc.id, name: svc.name, url: svc.url, to: "up", http_code: r.http_code, latency_ms: r.latency_ms });
      }

      return {
        id: svc.id,
        name: svc.name,
        url: svc.url,
        order: idx,
        status: reported,
        http_code: r.http_code,
        latency_ms: r.latency_ms,
        checked_at: now,
        consecutive_fails: failCount,
        uptime_24h: uptimePct(history),
        uptime_history: history,
        // record when the current reported state began
        since: prevReported === reported && p.since ? p.since : now,
      };
    })
  );

  const anyDown = results.some((s) => s.status === "down");
  const anyDegraded = results.some((s) => s.status === "degraded");
  const overall = anyDown ? "down" : anyDegraded ? "degraded" : "up";

  const output = {
    schema: 1,
    overall,
    updated_at: now,
    generated_at: now,
    interval_minutes: 5,
    services: results,
  };

  mkdirSync(dirname(OUT_PATH) === "" ? "." : dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");

  // concise, secret-free log line
  console.log(
    `probe ${now} overall=${overall} ` +
    results.map((s) => `${s.id}:${s.status}(${s.http_code}/${s.latency_ms}ms)`).join(" ")
  );

  if (transitions.length) {
    console.log(`transitions: ${transitions.map((t) => t.id + "->" + t.to).join(", ")}`);
    await sendAlert(transitions);
  }
}

main().catch((err) => {
  console.error("probe crashed:", err && err.message ? err.message : err);
  process.exit(1);
});
