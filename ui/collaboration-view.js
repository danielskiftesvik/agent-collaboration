/* Classic browser script. No require, export, or ES modules. */
(function (root) {
  function lineageToView(record) {
    var rec = record || {};
    var decision = rec.decision || null;
    var job = rec.job || null;
    var status = decision && decision.status ? String(decision.status) : "pending";
    return {
      id: rec.id || null,
      from: rec.from || null,
      to: rec.to || null,
      computer: rec.computer || null,
      harness: (decision && decision.harness) || rec.assignedHarness || null,
      hintHarness: rec.hintHarness || null,
      text: rec.text || null,
      pending: !decision,
      decisionStatus: status,
      decisionReason: decision && decision.reason ? String(decision.reason) : null,
      kind: decision && decision.kind ? String(decision.kind) : null,
      jobId: (job && job.id) || (decision && decision.jobId) || null,
      jobStatus: job && job.status ? String(job.status) : null,
      replyText: rec.reply && rec.reply.text ? String(rec.reply.text) : null,
      createdAt: rec.createdAt || null
    };
  }

  function rosterToView(machines) {
    var rows = machines || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i] || {};
      var sess = m.session || {};
      out.push({
        computer: m.computer || null,
        available: Boolean(m.available),
        activity: m.activity || "none",
        harness: m.harness || sess.harness || null,
        session: sess.name || null
      });
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function machineCard(m) {
    return (
      '<div class="machine">' +
      "<strong>" +
      escapeHtml(m.computer || "unknown") +
      "</strong> " +
      escapeHtml(m.available ? "awake" : "asleep") +
      " / " +
      escapeHtml(m.activity || "none") +
      " / " +
      escapeHtml(m.harness || "-") +
      (m.session ? " (" + escapeHtml(m.session) + ")" : "") +
      "</div>"
    );
  }

  function assignRow(v, selected) {
    return (
      '<button type="button" class="assign' +
      (selected ? " selected" : "") +
      '" data-id="' +
      escapeHtml(v.id) +
      '">' +
      "<span>" +
      escapeHtml(v.from || "-") +
      " → " +
      escapeHtml(v.to || "-") +
      "</span> " +
      "<span>" +
      escapeHtml(v.computer || "-") +
      " / " +
      escapeHtml(v.harness || "-") +
      "</span> " +
      "<strong>" +
      escapeHtml(v.decisionStatus) +
      "</strong>" +
      "</button>"
    );
  }

  function detailHtml(v) {
    if (!v) return "<p>Select an assign.</p>";
    return (
      "<dl>" +
      "<dt>Assign</dt><dd>" +
      escapeHtml(v.id) +
      "</dd>" +
      "<dt>From</dt><dd>" +
      escapeHtml(v.from) +
      "</dd>" +
      "<dt>To</dt><dd>" +
      escapeHtml(v.to) +
      "</dd>" +
      "<dt>Machine</dt><dd>" +
      escapeHtml(v.computer) +
      "</dd>" +
      "<dt>Harness</dt><dd>" +
      escapeHtml(v.harness) +
      "</dd>" +
      "<dt>Hint</dt><dd>" +
      escapeHtml(v.hintHarness) +
      "</dd>" +
      "<dt>Text</dt><dd>" +
      escapeHtml(v.text) +
      "</dd>" +
      "<dt>Decision</dt><dd>" +
      escapeHtml(v.decisionStatus) +
      (v.decisionReason ? " " + escapeHtml(v.decisionReason) : "") +
      "</dd>" +
      "<dt>Kind</dt><dd>" +
      escapeHtml(v.kind) +
      "</dd>" +
      "<dt>Job</dt><dd>" +
      escapeHtml(v.jobId) +
      (v.jobStatus ? " (" + escapeHtml(v.jobStatus) + ")" : "") +
      "</dd>" +
      "<dt>Reply</dt><dd><pre>" +
      escapeHtml(v.replyText) +
      "</pre></dd>" +
      "</dl>"
    );
  }

  function installCollaboration(root, data, selectedId) {
    var payload = data || { machines: [], assigns: [] };
    var machines = rosterToView(payload.machines);
    var assigns = [];
    var src = payload.assigns || [];
    for (var i = 0; i < src.length; i++) assigns.push(lineageToView(src[i]));
    var pick = selectedId || (assigns[0] && assigns[0].id);
    var selected = null;
    for (var j = 0; j < assigns.length; j++) {
      if (assigns[j].id === pick) selected = assigns[j];
    }
    if (!selected && assigns[0]) {
      selected = assigns[0];
      pick = selected.id;
    }
    var html = "<h1>Fleet collaboration</h1>";
    html += '<section id="machines"><h2>Machines</h2>';
    if (!machines.length) html += "<p>No machines.</p>";
    for (var m = 0; m < machines.length; m++) html += machineCard(machines[m]);
    html += '</section><section id="assigns"><h2>Assigns</h2>';
    if (!assigns.length) html += "<p>No assigns yet.</p>";
    for (var a = 0; a < assigns.length; a++) {
      html += assignRow(assigns[a], assigns[a].id === pick);
    }
    html += '</section><section id="detail"><h2>Lineage</h2>';
    html += detailHtml(selected);
    html += "</section>";
    root.innerHTML = html;
    root.collabSelectedId = pick || null;
    if (root.querySelectorAll) {
      var buttons = root.querySelectorAll("button.assign");
      for (var b = 0; b < buttons.length; b++) {
        buttons[b].onclick = (function (id) {
          return function () {
            installCollaboration(root, payload, id);
          };
        })(buttons[b].getAttribute("data-id"));
      }
    }
    return { machines: machines, assigns: assigns, selected: selected };
  }

  root.PeerCollabView = {
    lineageToView: lineageToView,
    rosterToView: rosterToView,
    installCollaboration: installCollaboration
  };
})(typeof window !== "undefined" ? window : globalThis);
