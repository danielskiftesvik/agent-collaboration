/* Classic page driver. Fetches live data from peers serve; file:// uses fixture. */
(function () {
  function banner(text) {
    var el = document.getElementById("collab-banner");
    if (!el) {
      el = document.createElement("p");
      el.id = "collab-banner";
      if (document.body) document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = text;
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

  function paint(data) {
    var root = document.getElementById("app");
    if (!root || !window.PeerCollabView) {
      banner("Collaboration view failed to install.");
      return;
    }
    window.PeerCollabView.installCollaboration(root, data);
  }

  function start() {
    var fileish = !window.location || window.location.protocol === "file:";
    if (fileish) {
      banner("Opened as a file. Showing fixture data. For live fleet state open http://<this-machine>:8744/collab via peers serve.");
      paint(fixture());
      return;
    }
    var req = new XMLHttpRequest();
    req.open("GET", "/peers/collab", true);
    req.onreadystatechange = function () {
      if (req.readyState !== 4) return;
      if (req.status >= 200 && req.status < 300) {
        try {
          paint(JSON.parse(req.responseText));
          banner("Live from peers serve. Refresh to update.");
        } catch (e) {
          banner("Live JSON parse failed; showing fixture. " + e.message);
          paint(fixture());
        }
        return;
      }
      banner("Could not load /peers/collab (" + req.status + "). Showing fixture. Use peers serve, or stay on this sample.");
      paint(fixture());
    };
    req.onerror = function () {
      banner("Network error loading /peers/collab (file:// CORS cannot read lineage.json). Showing fixture.");
      paint(fixture());
    };
    try {
      req.send();
    } catch (e) {
      banner("Request blocked. Showing fixture. " + e.message);
      paint(fixture());
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
