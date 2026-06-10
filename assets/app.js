/* Kattenberg 118 — Status page client
 * Reads status.json (produced by the prober GitHub Action) and renders the page.
 * Off-NAS by design: the JSON is fetched from GitHub raw, so this page keeps
 * working even when the NAS / its services are down.
 *
 * Note: all rendering uses textContent / DOM nodes (no innerHTML) so untrusted
 * JSON can never inject markup. */

(function () {
  "use strict";

  // The prober force-pushes status.json to the `status-data` branch of this repo.
  // Raw GitHub is globally CDN-cached and independent of the NAS.
  var DATA_URL =
    "https://raw.githubusercontent.com/Kattenberg-118/kattenberg118-status/status-data/status.json";

  // Allow a local data source for previews/self-hosting without touching code,
  // e.g. ?src=/status.json. Same-origin / relative paths only.
  (function () {
    try {
      var src = new URLSearchParams(location.search).get("src");
      if (src && /^[./]/.test(src)) DATA_URL = src;
    } catch (e) {}
  })();

  var REFRESH_MS = 60 * 1000; // re-poll the JSON once a minute (probe itself runs ~5 min)

  var LABELS = {
    up: "Operationeel",
    degraded: "Verstoord",
    down: "Storing",
    unknown: "Onbekend",
  };

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtRelative(iso) {
    if (!iso) return "onbekend";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "onbekend";
    var diff = Math.round((Date.now() - then) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 60) return "zojuist";
    if (diff < 3600) {
      var m = Math.floor(diff / 60);
      return m + (m === 1 ? " minuut" : " minuten") + " geleden";
    }
    if (diff < 86400) {
      var h = Math.floor(diff / 3600);
      return h + " uur geleden";
    }
    var d = Math.floor(diff / 86400);
    return d + (d === 1 ? " dag" : " dagen") + " geleden";
  }

  function fmtClock(iso) {
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return "—";
    try {
      return dt.toLocaleString("nl-BE", {
        day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit",
        timeZone: "Europe/Brussels",
      });
    } catch (e) {
      return dt.toISOString();
    }
  }

  function overall(services) {
    var down = 0, degraded = 0, total = services.length;
    services.forEach(function (s) {
      if (s.status === "down") down++;
      else if (s.status === "degraded") degraded++;
    });
    if (down > 0) return { state: "down", down: down, degraded: degraded, total: total };
    if (degraded > 0) return { state: "degraded", down: 0, degraded: degraded, total: total };
    return { state: "up", down: 0, degraded: 0, total: total };
  }

  function overviewCopy(o) {
    if (o.state === "up") {
      return { title: "Alle diensten operationeel", sub: "Alles draait normaal." };
    }
    if (o.state === "degraded") {
      var n = o.degraded;
      return {
        title: n === 1 ? "Eén dienst verstoord" : n + " diensten verstoord",
        sub: "We zien verhoogde reactietijden of tijdelijke haperingen.",
      };
    }
    var d = o.down;
    return {
      title: d === 1 ? "Eén dienst onbereikbaar" : d + " diensten onbereikbaar",
      sub: "We zijn op de hoogte en kijken ernaar.",
    };
  }

  function metaBits(s) {
    var bits = [];
    if (s.status === "up" || s.status === "degraded") {
      if (typeof s.latency_ms === "number") bits.push(s.latency_ms + " ms");
      if (typeof s.http_code === "number" && s.http_code > 0) bits.push("HTTP " + s.http_code);
    } else if (s.status === "down") {
      if (typeof s.http_code === "number" && s.http_code > 0) bits.push("HTTP " + s.http_code);
      else bits.push("geen verbinding");
    }
    if (typeof s.uptime_24h === "number") {
      bits.push(s.uptime_24h.toFixed(s.uptime_24h >= 100 ? 0 : 1) + "% / 24u");
    }
    return bits;
  }

  function renderServices(services) {
    var list = $("services");
    list.setAttribute("aria-busy", "false");
    list.textContent = "";

    services.forEach(function (s) {
      var state = ["up", "degraded", "down"].indexOf(s.status) >= 0 ? s.status : "unknown";

      var li = el("li", "service");
      li.setAttribute("data-state", state);

      var dot = el("span", "svc-dot");
      dot.setAttribute("aria-hidden", "true");
      li.appendChild(dot);

      var main = el("div", "svc-main");
      main.appendChild(el("div", "svc-name", s.name != null ? s.name : "—"));

      var bits = metaBits(s);
      if (bits.length) {
        var meta = el("div", "svc-meta");
        bits.forEach(function (b, i) {
          if (i > 0) meta.appendChild(el("span", "sep", "·"));
          meta.appendChild(document.createTextNode(b));
        });
        main.appendChild(meta);
      }
      li.appendChild(main);

      li.appendChild(el("span", "svc-status", LABELS[state] || LABELS.unknown));
      list.appendChild(li);
    });
  }

  function render(data) {
    $("errorBox").hidden = true;
    var services = Array.isArray(data.services) ? data.services.slice() : [];

    // stable display order if the prober ever reorders
    services.sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });

    var o = overall(services);
    var copy = overviewCopy(o);

    var ov = $("overview");
    ov.setAttribute("data-state", o.state);
    $("ovTitle").textContent = copy.title;
    $("ovSub").textContent = copy.sub;

    renderServices(services);

    var ts = data.updated_at || data.generated_at;
    $("updated").textContent =
      "Laatst bijgewerkt " + fmtRelative(ts) + " · " + fmtClock(ts);
  }

  function showError() {
    var list = $("services");
    if (list.getAttribute("aria-busy") === "true") {
      list.setAttribute("aria-busy", "false");
      list.textContent = "";
    }
    var ov = $("overview");
    if (!ov.getAttribute("data-state")) {
      $("ovTitle").textContent = "Status tijdelijk niet beschikbaar";
      $("ovSub").textContent = "We konden de meetgegevens niet ophalen.";
    }
    $("errorBox").hidden = false;
  }

  function load() {
    fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function (err) {
        console.warn("status fetch failed:", err);
        showError();
      });
  }

  /* ---- theme toggle (respects OS, remembers choice) ---- */
  function initTheme() {
    var root = document.documentElement;
    var stored = null;
    try { stored = localStorage.getItem("k118-theme"); } catch (e) {}
    var prefersDark = window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", stored || (prefersDark ? "dark" : "light"));

    var btn = $("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try { localStorage.setItem("k118-theme", next); } catch (e) {}
      });
    }
  }

  initTheme();
  load();
  setInterval(load, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) load();
  });
})();
