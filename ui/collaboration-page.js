/* Classic page driver. Live HTTP polls /peers/collab; file:// uses fixture. */
(function (root) {
  var POLL_MS = 4000;

  function banner(text) {
    var el = document.getElementById("collab-banner");
    if (!el) {
      el = document.createElement("p");
      el.id = "collab-banner";
      if (el.setAttribute) {
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
      }
      if (document.body) document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = text;
  }

  function liveBannerText() {
    return "Live from peers serve. Updates automatically.";
  }

  function isFileLocation(loc) {
    return !loc || loc.protocol === "file:";
  }

  function liveViewKey(data) {
    var payload = data || {};
    var machines = payload.machines || [];
    var assigns = payload.assigns || [];
    var m = [];
    for (var i = 0; i < machines.length; i++) {
      var x = machines[i] || {};
      var sess = x.session || {};
      m.push([x.computer, Boolean(x.available), x.activity || "", x.harness || sess.harness || "", sess.name || ""]);
    }
    var a = [];
    for (var j = 0; j < assigns.length; j++) {
      var r = assigns[j] || {};
      var d = r.decision || {};
      var job = r.job || {};
      var reply = r.reply || {};
      a.push([
        r.id || "",
        d.status || "",
        d.reason || "",
        d.kind || "",
        d.harness || r.assignedHarness || "",
        job.id || "",
        job.status || "",
        reply.text || ""
      ]);
    }
    return JSON.stringify({ m: m, a: a });
  }

  function fixture() {
    var node = document.getElementById("collab-fixture");
    if (!node || !node.textContent) return { machines: [], assigns: [] };
    try {
      return JSON.parse(node.textContent);
    } catch (e) {
      banner("Fixture JSON is invalid: " + e.message);
      return { machines: [], assigns: [] };
    }
  }

  function paint(data, selectedId) {
    var app = document.getElementById("app");
    if (!app || !window.PeerCollabView) {
      banner("Collaboration view failed to install.");
      return null;
    }
    return window.PeerCollabView.installCollaboration(app, data, selectedId);
  }

  function startLive(opts) {
    var intervalMs = opts.intervalMs != null ? opts.intervalMs : POLL_MS;
    var selectedId = opts.selectedId || null;
    var lastJson = null;
    var stopped = false;

    function currentSelected() {
      if (opts.getSelectedId) {
        var live = opts.getSelectedId();
        if (live) selectedId = live;
      }
      return selectedId;
    }

    function apply(data) {
      var json = liveViewKey(data);
      if (lastJson === json) return;
      lastJson = json;
      var painted = opts.paint(data, currentSelected());
      if (painted && painted.selected && painted.selected.id) selectedId = painted.selected.id;
      if (opts.banner) opts.banner(liveBannerText());
    }

    function tick() {
      if (stopped) return;
      opts.load(function (err, data) {
        if (stopped) return;
        if (err) {
          if (opts.banner) opts.banner(err.message || String(err));
          return;
        }
        apply(data);
      });
    }

    tick();
    var handle = opts.schedule(tick, intervalMs);
    return {
      stop: function () {
        stopped = true;
        if (opts.unschedule) opts.unschedule(handle);
      },
      getSelectedId: function () {
        return selectedId;
      }
    };
  }

  function loadXhr(cb) {
    var req = new XMLHttpRequest();
    req.open("GET", "/peers/collab", true);
    req.onreadystatechange = function () {
      if (req.readyState !== 4) return;
      if (req.status >= 200 && req.status < 300) {
        try {
          cb(null, JSON.parse(req.responseText));
        } catch (e) {
          cb(e);
        }
        return;
      }
      cb(new Error("Could not load /peers/collab (" + req.status + "). Showing fixture. Use peers serve, or stay on this sample."));
    };
    req.onerror = function () {
      cb(new Error("Network error loading /peers/collab (file:// CORS cannot read lineage.json). Showing fixture."));
    };
    try {
      req.send();
    } catch (e) {
      cb(e);
    }
  }

  function start() {
    if (isFileLocation(typeof window !== "undefined" ? window.location : null)) {
      banner(
        "Opened as a file. Showing fixture data. For live fleet state open http://<this-machine>:8744/collab via peers serve."
      );
      paint(fixture());
      return;
    }
    var app = document.getElementById("app");
    startLive({
      load: function (cb) {
        loadXhr(function (err, data) {
          if (err) {
            banner(err.message);
            paint(fixture());
            return;
          }
          cb(null, data);
        });
      },
      paint: paint,
      getSelectedId: function () {
        return app ? app.collabSelectedId : null;
      },
      banner: banner,
      schedule: function (fn, ms) {
        return setInterval(fn, ms);
      },
      unschedule: function (id) {
        clearInterval(id);
      }
    });
  }

  root.PeerCollabPage = {
    POLL_MS: POLL_MS,
    isFileLocation: isFileLocation,
    liveBannerText: liveBannerText,
    liveViewKey: liveViewKey,
    startLive: startLive
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : globalThis);
