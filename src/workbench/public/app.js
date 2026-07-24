const state = {
  overview: null,
  projects: [],
  insights: null,
  insightsError: null,
  sources: [],
  receipts: [],
  receiptError: null,
  candidateFilter: "all",
  patternFilters: {
    query: "",
    kind: "all",
    signal: "all",
    role: "all",
    outcome: "all",
    review: "all",
    harness: "all",
    from: "",
    to: "",
  },
  selectedPatternHandle: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const formatNumber = (value) => new Intl.NumberFormat("en", { notation: value > 99999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
const formatDate = (value) => value ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value)) : "Unknown";
const formatRate = (value) => value == null ? "—" : `${Math.round(Number(value) * 100)}%`;
const formatRateDelta = (value) => value == null ? "—" : `${value > 0 ? "+" : ""}${Math.round(Number(value) * 100)} pp`;
const relativeTime = (value) => {
  if (!value) return "unknown";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size || unit === "minute") return formatter.format(Math.round(seconds / size), unit);
};
const shortProject = (project = "") => project.replace(/^\/srv\/share\/projects\//, "").replace(/^\/tmp\//, "tmp/") || "(unknown)";

async function api(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

async function apiMutation(path, input) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderOverview() {
  const overview = state.overview;
  if (!overview?.ready) {
    $("#sync-copy").textContent = "Corpus not initialized";
    $("#stat-grid").innerHTML = `<article class="stat-card"><div class="stat-value">No corpus yet</div><div class="stat-foot">Run an ingest or import command to begin.</div></article>`;
    return;
  }
  const { corpus, harnesses, projects, recent, tools } = overview;
  $("#data-root").textContent = overview.root;
  $("#corpus-range").textContent = `${formatDate(corpus.firstSession)} — ${formatDate(corpus.lastSession)}`;
  $("#overview-subtitle").textContent = `${formatNumber(corpus.sessions)} sessions resolved across ${formatNumber(corpus.projects)} project paths.`;
  const topHarness = harnesses[0];
  const topTool = tools[0];
  const stats = [
    ["Sessions", corpus.sessions, `${formatNumber(corpus.turns)} canonical turns`, "⌁"],
    ["Projects", corpus.projects, `${shortProject(projects[0]?.project)} leads activity`, "◇"],
    ["Sources", harnesses.length, topHarness ? `${topHarness.harness} · ${formatNumber(topHarness.sessions)}` : "No sources", "◌"],
    ["Top tool", topTool?.calls || 0, topTool ? `${topTool.name} calls` : "No tool data", "⌘"],
  ];
  $("#stat-grid").innerHTML = stats.map(([label, value, foot, icon]) => `
    <article class="stat-card">
      <div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon}</span></div>
      <div class="stat-value">${formatNumber(value)}</div>
      <div class="stat-foot">${escapeHtml(foot)}</div>
    </article>`).join("");

  $("#recent-sessions").innerHTML = recent.map((session) => `
    <div class="timeline-row">
      <span class="timeline-dot"></span>
      <div class="timeline-copy">
        <strong>${escapeHtml(session.title || shortProject(session.project))}</strong>
        <span>${escapeHtml(session.harness)} · ${formatNumber(session.turns)} turns · <span class="badge ${escapeHtml(session.domain)}">${escapeHtml(session.domain)}</span></span>
      </div>
      <span class="timeline-time">${relativeTime(session.endedAt)}</span>
    </div>`).join("") || `<div class="empty">No sessions found.</div>`;

  const maximum = Math.max(...projects.map((project) => Number(project.sessions)), 1);
  $("#project-focus").innerHTML = projects.slice(0, 6).map((project) => `
    <div class="focus-row">
      <strong>${escapeHtml(shortProject(project.project))}</strong>
      <span>${formatNumber(project.sessions)} sessions</span>
      <div class="focus-track"><i style="width:${Math.max(3, Number(project.sessions) / maximum * 100)}%"></i></div>
    </div>`).join("");
}

function renderProjects(filter = "") {
  const term = filter.toLowerCase();
  const projects = state.projects.filter((project) => project.project.toLowerCase().includes(term));
  $("#project-count").textContent = `${projects.length} projects`;
  $("#project-list").innerHTML = projects.map((project) => `
    <article class="project-card" data-project="${escapeHtml(project.project)}">
      <div class="project-card-head"><span class="project-symbol">◇</span><span class="badge">${relativeTime(project.lastSeen)}</span></div>
      <h3 title="${escapeHtml(project.project)}">${escapeHtml(shortProject(project.project))}</h3>
      <p>${formatNumber(project.sessions)} sessions · ${formatNumber(project.turns)} turns</p>
    </article>`).join("") || `<div class="empty spacious">No matching projects.</div>`;
  $$(".project-card").forEach((card) => card.addEventListener("click", () => openProject(card.dataset.project)));
}

async function openProject(project) {
  const drawer = $("#project-drawer");
  $("#project-drawer-title").textContent = shortProject(project);
  $("#project-sessions").innerHTML = `<div class="empty">Loading sessions…</div>`;
  drawer.classList.remove("hidden");
  drawer.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const sessions = await api(`/api/sessions?project=${encodeURIComponent(project)}&limit=100`);
    $("#project-sessions").innerHTML = sessions.map((session) => `
      <div class="session-row">
        <div><strong>${escapeHtml(session.title || session.id)}</strong><span>${escapeHtml(session.model)}</span></div>
        <span>${escapeHtml(session.harness)}</span>
        <span>${formatNumber(session.turns)} turns</span>
        <span>${relativeTime(session.endedAt)}</span>
      </div>`).join("") || `<div class="empty">No sessions found.</div>`;
  } catch (error) {
    $("#project-sessions").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function runSearch(query) {
  const input = query.trim();
  if (!input) return;
  showView("recall");
  $("#recall-input").value = input;
  $("#result-meta").textContent = "Searching the local FTS index…";
  $("#search-results").innerHTML = `<div class="empty spacious">Resolving evidence…</div>`;
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(input)}&limit=36`);
    $("#result-meta").textContent = `${result.hits.length} ranked turn matches · local lexical search · no egress`;
    $("#search-results").innerHTML = result.hits.map((hit) => {
      const snippet = escapeHtml(hit.snippet).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
      return `<article class="search-hit" data-uri="${escapeHtml(hit.evidenceUri)}">
        <span class="hit-accent"></span>
        <div>
          <div class="hit-head"><strong>${escapeHtml(hit.title || shortProject(hit.project))}</strong><span class="badge">${escapeHtml(hit.harness)}</span><span class="badge ${escapeHtml(hit.domain)}">${escapeHtml(hit.domain)}</span></div>
          <p class="hit-snippet">${snippet}</p>
          <div class="hit-pointer">${escapeHtml(hit.evidenceUri)}</div>
        </div>
        <span class="hit-score">${Number(hit.score).toFixed(2)}</span>
      </article>`;
    }).join("") || `<div class="empty spacious">No matching evidence. Try fewer or broader terms.</div>`;
    $$(".search-hit").forEach((hit) => hit.addEventListener("click", () => openEvidence(hit.dataset.uri)));
  } catch (error) {
    $("#result-meta").textContent = "Search failed";
    $("#search-results").innerHTML = `<div class="empty spacious">${escapeHtml(error.message)}</div>`;
  }
}

async function openEvidence(uri) {
  const dialog = $("#evidence-dialog");
  $("#evidence-content").textContent = "Loading canonical turn…";
  dialog.showModal();
  try {
    const evidence = await api(`/api/evidence?uri=${encodeURIComponent(uri)}`);
    $("#evidence-title").textContent = evidence.title || shortProject(evidence.project);
    $("#evidence-meta").innerHTML = [
      evidence.harness, evidence.domain, `turn ${evidence.turnIndex}`, evidence.project,
    ].map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join("");
    $("#evidence-content").textContent = evidence.turn.content || `[${evidence.turn.role} turn with no textual content]`;
  } catch (error) {
    $("#evidence-content").textContent = error.message;
  }
}

const patternDisposition = (pattern) =>
  pattern.annotation?.disposition || "unreviewed";

function patternMatchesFilters(pattern) {
  const filters = state.patternFilters;
  const annotation = pattern.annotation || {};
  const searchable = [
    annotation.label,
    annotation.note,
    pattern.title,
    pattern.claim,
    pattern.kind,
    pattern.signal,
    pattern.role,
    ...(pattern.coverage?.harnesses || []),
  ].filter(Boolean).join(" ").toLowerCase();
  if (filters.query && !searchable.includes(filters.query.toLowerCase()))
    return false;
  if (filters.kind !== "all" && pattern.kind !== filters.kind) return false;
  if (filters.signal !== "all" && pattern.signal !== filters.signal)
    return false;
  if (filters.role !== "all" && pattern.role !== filters.role) return false;
  if (
    filters.outcome !== "all"
    && pattern.outcomes?.status !== filters.outcome
  ) return false;
  if (
    filters.review !== "all"
    && patternDisposition(pattern) !== filters.review
  ) return false;
  if (
    filters.harness !== "all"
    && !(pattern.coverage?.harnesses || []).includes(filters.harness)
  ) return false;
  if (filters.from || filters.to) {
    const from = filters.from || "0000-01-01";
    const to = filters.to || "9999-12-31";
    const occurrences = pattern.sequence?.timeline || [];
    if (!occurrences.some((item) => {
      const day = String(item.occurredAt || "").slice(0, 10);
      return day >= from && day <= to;
    })) return false;
  }
  return true;
}

function renderWorkflowPatterns(patterns) {
  const all = patterns?.patterns || [];
  const summary = patterns?.summary || {};
  const annotationState = patterns?.annotations;
  $("#workflow-patterns-count").textContent =
    `${formatNumber(summary.repeatedPatterns)} repeated`;
  $("#workflow-patterns-summary").innerHTML = `
    <div class="workflow-pattern-summary">
      <div><strong>${formatNumber(summary.repeatedPatterns)}</strong><span>multi-day repeated patterns</span></div>
      <div><strong>${formatNumber(summary.candidateSignatures)}</strong><span>deterministic signatures</span></div>
      <div><strong>${formatNumber(summary.outcomeObservedPatterns)}</strong><span>with repeated outcome coverage</span></div>
      <div><strong>${formatNumber(annotationState?.summary?.confirmed)}</strong><span>operator confirmed</span></div>
    </div>
    <p class="pattern-causality">${escapeHtml(patterns.methodology?.causality || "Outcome directions are descriptive and do not establish causation.")}</p>`;

  const harnesses = [...new Set(all.flatMap(
    (pattern) => pattern.coverage?.harnesses || [],
  ))].sort();
  const harnessSelect = $("#pattern-filter-harness");
  const currentHarness = state.patternFilters.harness;
  harnessSelect.innerHTML = [
    `<option value="all">All harnesses</option>`,
    ...harnesses.map((harness) =>
      `<option value="${escapeHtml(harness)}">${escapeHtml(harness)}</option>`
    ),
  ].join("");
  harnessSelect.value = harnesses.includes(currentHarness)
    ? currentHarness
    : "all";
  state.patternFilters.harness = harnessSelect.value;

  const filtered = all.filter(patternMatchesFilters);
  $("#pattern-filter-meta").textContent =
    `${filtered.length} of ${all.length} patterns · date filters inspect the bounded occurrence timeline`;
  $("#workflow-pattern-list").innerHTML = filtered.map((pattern) => {
    const relations = pattern.sequence?.relations || {};
    const outcome = pattern.outcomes || {};
    const metric = outcome.metrics?.completionRate;
    const annotation = pattern.annotation;
    return `<article class="workflow-pattern-card" data-handle="${escapeHtml(pattern.handle)}">
      <div class="workflow-pattern-card-head">
        <div>
          <span class="pattern-review ${escapeHtml(patternDisposition(pattern))}">${escapeHtml(patternDisposition(pattern))}</span>
          <h3>${escapeHtml(annotation?.label || pattern.title)}</h3>
        </div>
        <span class="badge">${formatNumber(pattern.coverage?.distinctEpisodes)} episodes</span>
      </div>
      ${annotation?.label ? `<div class="workflow-pattern-derived-title">Derived as ${escapeHtml(pattern.title)}</div>` : ""}
      <p>${escapeHtml(pattern.claim)}</p>
      <div class="workflow-pattern-meta">
        ${formatNumber(pattern.coverage?.projectCount)} projects ·
        ${formatNumber(pattern.coverage?.eventMemberships)} event memberships ·
        ${formatNumber(pattern.coverage?.distinctDays)} UTC days ·
        ${escapeHtml(pattern.boundaryEffect?.replaceAll("-", " ") || "")}
      </div>
      ${pattern.coverage?.sharedEventMemberships ? `<div class="workflow-pattern-meta">${formatNumber(pattern.coverage.sharedEventMemberships)} memberships also contribute to another candidate signature.</div>` : ""}
      <div class="workflow-pattern-relations">
        <span>${formatNumber(relations.reinforced)} reinforced</span>
        <span>${formatNumber(relations.reformulated)} reformulated</span>
        <span>${formatNumber(relations["returned-to-prior"])} returned</span>
      </div>
      <div class="workflow-pattern-outcome">
        ${outcome.status === "observed"
          ? `<strong>Descriptive outcome coverage</strong> · ${formatNumber(outcome.observedEpisodes)} episodes${metric?.medianDelta == null ? "" : ` · completion median ${formatRateDelta(metric.medianDelta)}`}`
          : `Outcome association still sparse · ${formatNumber(outcome.observedEpisodes)} covered episodes`}
      </div>
      ${annotation?.note ? `<div class="pattern-annotation-note">${escapeHtml(annotation.note)}</div>` : ""}
      <button class="text-button open-pattern" data-handle="${escapeHtml(pattern.handle)}">Inspect and review →</button>
    </article>`;
  }).join("") || `<div class="empty">No workflow patterns match these filters.</div>`;
  $$(".open-pattern").forEach((button) =>
    button.addEventListener("click", () => openPattern(button.dataset.handle))
  );
}

function renderPatternDetail(pattern) {
  const dialog = $("#pattern-dialog");
  const annotation = pattern.annotation;
  state.selectedPatternHandle = pattern.handle;
  $("#pattern-detail-title").textContent = annotation?.label || pattern.title;
  $("#pattern-detail-subtitle").textContent = annotation?.label
    ? `Derived pattern: ${pattern.title}`
    : `${pattern.role} · ${pattern.signal}`;
  const relations = pattern.sequence?.relations || {};
  const outcome = pattern.outcomes || {};
  const methodology = state.insights?.workflowPatterns?.methodology || {};
  const metrics = [
    ["Completion", outcome.metrics?.completionRate],
    ["Friction", outcome.metrics?.frictionRate],
    ["Rework proxy", outcome.metrics?.reworkRate],
  ];
  $("#pattern-detail-content").innerHTML = `
    <p class="pattern-detail-claim">${escapeHtml(pattern.claim)}</p>
    <div class="pattern-detail-facts">
      <span>${formatNumber(pattern.coverage?.distinctEpisodes)} episodes</span>
      <span>${formatNumber(pattern.coverage?.distinctDays)} UTC days</span>
      <span>${formatNumber(pattern.coverage?.distinctFormulations)} formulations</span>
      <span>${escapeHtml((pattern.coverage?.harnesses || []).join(", ") || "unknown harness")}</span>
      <span>${escapeHtml(pattern.boundaryEffect?.replaceAll("-", " ") || "")}</span>
    </div>
    <p class="pattern-detail-methodology">${escapeHtml(methodology.boundaryEffect || "")} ${escapeHtml(methodology.causality || "")}</p>
    <div class="pattern-detail-section">
      <h3>Formulation history</h3>
      <div class="pattern-detail-relations">
        <span>${formatNumber(relations.introduced)} introduced</span>
        <span>${formatNumber(relations.reinforced)} reinforced</span>
        <span>${formatNumber(relations.reformulated)} reformulated</span>
        <span>${formatNumber(relations["returned-to-prior"])} returned to prior</span>
      </div>
      <div class="pattern-detail-timeline">${(pattern.sequence?.timeline || []).map((item) => `
        <div><span class="timeline-dot"></span><strong>${escapeHtml(item.relation.replaceAll("-", " "))}</strong><time>${escapeHtml(formatDate(item.occurredAt))}</time></div>
      `).join("") || `<div class="empty">No bounded timeline available.</div>`}</div>
    </div>
    <div class="pattern-detail-section">
      <h3>Descriptive outcome context</h3>
      <p>${escapeHtml(outcome.interpretation?.claim || "Coverage remains below the declared floor.")}</p>
      <div class="pattern-detail-metrics">${metrics.map(([label, metric]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${metric?.medianDelta == null ? "—" : formatRateDelta(metric.medianDelta)}</strong>
          <small>${formatNumber(metric?.samples)} samples · ${escapeHtml(metric?.orientation?.replaceAll("-", " ") || "not oriented")}</small>
        </div>
      `).join("")}</div>
    </div>
    <div class="pattern-detail-section">
      <h3>Canonical examples</h3>
      <div class="pattern-example-list">${(pattern.examples || []).map((example) => {
        const evidence = example.evidence?.[0];
        return `<div>
          <span>${escapeHtml(formatDate(example.occurredAt))} · ${escapeHtml(example.relation.replaceAll("-", " "))}</span>
          ${evidence ? `<button class="text-button pattern-detail-evidence" data-uri="${escapeHtml(evidence.pointer)}">Open evidence</button>` : ""}
        </div>`;
      }).join("") || `<div class="empty">No examples available.</div>`}</div>
    </div>`;

  const enabled = state.insights?.workflowPatterns?.annotations?.enabled;
  $("#pattern-annotation-disposition").value =
    annotation?.disposition || "unreviewed";
  $("#pattern-annotation-label").value = annotation?.label || "";
  $("#pattern-annotation-note").value = annotation?.note || "";
  $("#pattern-annotation-revision").textContent =
    annotation ? `Revision ${annotation.revision} · ${relativeTime(annotation.updatedAt)}` : "Not reviewed yet";
  $("#save-pattern-annotation").disabled = !enabled;
  $("#pattern-annotation-disposition").disabled = !enabled;
  $("#pattern-annotation-label").disabled = !enabled;
  $("#pattern-annotation-note").disabled = !enabled;
  $("#pattern-annotation-state").textContent = enabled
    ? "Your review is stored locally and never changes the derived evidence."
    : "Annotations are disabled for this deployment.";
  $$(".pattern-detail-evidence", dialog).forEach((button) =>
    button.addEventListener("click", () => openEvidence(button.dataset.uri))
  );
}

function openPattern(handle) {
  const pattern = state.insights?.workflowPatterns?.patterns
    ?.find((candidate) => candidate.handle === handle);
  if (!pattern) return;
  renderPatternDetail(pattern);
  $("#pattern-dialog").showModal();
}

async function savePatternAnnotation() {
  const patterns = state.insights?.workflowPatterns;
  const pattern = patterns?.patterns?.find(
    (candidate) => candidate.handle === state.selectedPatternHandle,
  );
  if (!pattern) return;
  const button = $("#save-pattern-annotation");
  const status = $("#pattern-annotation-state");
  button.disabled = true;
  status.textContent = "Saving private annotation…";
  try {
    await apiMutation("/api/pattern-annotations", {
      handle: pattern.handle,
      expectedRevision: pattern.annotation?.revision || 0,
      observedSnapshot: patterns.annotations?.snapshot,
      disposition: $("#pattern-annotation-disposition").value,
      label: $("#pattern-annotation-label").value,
      note: $("#pattern-annotation-note").value,
    });
    try {
      state.insights = await api("/api/insights");
    } catch (refreshError) {
      status.textContent =
        `Saved locally, but refresh failed: ${refreshError.message}`;
      return;
    }
    state.insightsError = null;
    renderInsights();
    const refreshed = state.insights?.workflowPatterns?.patterns
      ?.find((candidate) => candidate.handle === pattern.handle);
    if (refreshed) renderPatternDetail(refreshed);
    status.textContent = "Saved locally.";
  } catch (error) {
    if (error.status === 409) {
      try {
        state.insights = await api("/api/insights");
        renderInsights();
        const refreshed = state.insights?.workflowPatterns?.patterns
          ?.find((candidate) => candidate.handle === pattern.handle);
        if (refreshed) renderPatternDetail(refreshed);
        status.textContent =
          "The pattern or annotation changed. Review the refreshed values before saving.";
      } catch (refreshError) {
        status.textContent =
          `The pattern changed, but refresh failed: ${refreshError.message}`;
      }
    } else {
      status.textContent = error.message;
    }
  } finally {
    button.disabled = !state.insights?.workflowPatterns?.annotations?.enabled;
  }
}

function renderInsights() {
  if (state.insightsError) {
    const message = `Insights unavailable: ${state.insightsError}`;
    $("#orchestration-claim").textContent = message;
    $("#workflow-evolution-count").textContent = "Unavailable";
    $("#workflow-evolution-summary").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    $("#workflow-event-list").innerHTML = "";
    $("#workflow-outcomes-count").textContent = "Unavailable";
    $("#workflow-outcomes-summary").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    $("#workflow-outcome-list").innerHTML = "";
    $("#workflow-patterns-count").textContent = "Unavailable";
    $("#workflow-patterns-summary").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    $("#workflow-pattern-list").innerHTML = "";
    $("#role-profiles").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    $("#effectiveness-result").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    $("#candidate-list").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    return;
  }
  const insights = state.insights || {};
  $("#orchestration-claim").textContent = insights.orchestration?.claim || "No orchestration profile has been derived yet.";
  const patterns = insights.workflowPatterns;
  if (!patterns) {
    $("#workflow-patterns-count").textContent = "Not derived";
    $("#workflow-patterns-summary").innerHTML = `<div class="empty">Run <code>chatlog query workflow-patterns</code> to synthesize repeated operator instructions.</div>`;
    $("#workflow-pattern-list").innerHTML = "";
  } else {
    renderWorkflowPatterns(patterns);
  }
  const workflow = insights.workflowEvolution;
  if (!workflow) {
    $("#workflow-evolution-count").textContent = "Not derived";
    $("#workflow-evolution-summary").innerHTML = `<div class="empty">Run <code>chatlog query workflow-evolution</code> to build the local event ledger.</div>`;
    $("#workflow-event-list").innerHTML = "";
  } else {
    const summary = workflow.summary || {};
    const tracer = workflow.approvalGateTracer;
    $("#workflow-evolution-count").textContent = `${formatNumber(summary.uniqueEvents)} events`;
    $("#workflow-evolution-summary").innerHTML = `
      <div class="evolution-metrics">
        <div><strong>${formatNumber(summary.uniqueEvents)}</strong><span>unique decisions</span></div>
        <div><strong>${formatNumber(summary.duplicateCopiesCollapsed)}</strong><span>fan-out copies collapsed</span></div>
        <div><strong>${formatNumber(summary.episodes)}</strong><span>opaque session lineages</span></div>
      </div>
      ${tracer ? `<div class="evolution-tracer">
        <span class="badge">Approval tracer · ${escapeHtml(formatDate(tracer.occurredAt))}</span>
        <strong>${escapeHtml(tracer.policyDelta?.after || tracer.statement)}</strong>
        <p>${escapeHtml(tracer.policyDelta?.retained?.join(" · ") || "No retained boundary was inferred from this statement.")}</p>
        ${tracer.evidence?.[0] ? `<button class="text-button workflow-evidence" data-uri="${escapeHtml(tracer.evidence[0].pointer)}">Open canonical evidence →</button>` : ""}
      </div>` : `<div class="empty">No explicit approval-policy change is present in the active corpus.</div>`}`;
    $("#workflow-event-list").innerHTML = (workflow.events || []).map((event) => `
      <div class="workflow-event">
        <span class="timeline-dot"></span>
        <div>
          <div class="workflow-event-head">
            <strong>${escapeHtml(event.kind.replaceAll("-", " "))}</strong>
            <span>${escapeHtml(formatDate(event.occurredAt))}</span>
          </div>
          <p>${escapeHtml(event.statement)}</p>
          <div class="workflow-event-meta">
            ${formatNumber(event.lineage?.conversations)} conversations ·
            ${formatNumber(event.lineage?.duplicateCopiesCollapsed)} copies collapsed ·
            ${escapeHtml((event.lineage?.roles || []).join(", ") || "unclassified")}
          </div>
          ${event.evidence?.[0] ? `<button class="text-button workflow-evidence" data-uri="${escapeHtml(event.evidence[0].pointer)}">Inspect evidence</button>` : ""}
        </div>
      </div>`).join("") || `<div class="empty">No explicit workflow events found.</div>`;
    $$(".workflow-evidence").forEach((button) =>
      button.addEventListener("click", () => openEvidence(button.dataset.uri))
    );
  }
  const outcomes = insights.workflowOutcomes;
  if (!outcomes) {
    $("#workflow-outcomes-count").textContent = "Not derived";
    $("#workflow-outcomes-summary").innerHTML = `<div class="empty">Run <code>chatlog query workflow-outcomes</code> to add descriptive pre/post context.</div>`;
    $("#workflow-outcome-list").innerHTML = "";
  } else {
    const comparison = outcomes.approvalGateTracer;
    $("#workflow-outcomes-count").textContent = `${formatNumber(outcomes.summary?.observed)} observed · ${formatNumber(outcomes.summary?.events)} total`;
    if (!comparison) {
      $("#workflow-outcomes-summary").innerHTML = `<div class="empty">No approval-gate comparison is available.</div>`;
    } else if (comparison.status !== "observed") {
      $("#workflow-outcomes-summary").innerHTML = `
        <div class="outcome-caveat">
          <strong>Approval tracer is still collecting evidence.</strong>
          <p>${escapeHtml(comparison.reasons?.join(" · ") || "Coverage is below the declared floor.")}</p>
          <span>${formatNumber(comparison.coverage?.preEpisodes)} pre episodes · ${formatNumber(comparison.coverage?.postEpisodes)} post episodes · ${formatNumber(comparison.scope?.observedWindowHours)} hour symmetric window</span>
        </div>`;
    } else {
      const metrics = [
        ["Completion", comparison.pre?.outcomes?.completionRate, comparison.post?.outcomes?.completionRate, comparison.deltas?.completionRate],
        ["Friction", comparison.pre?.friction?.rate, comparison.post?.friction?.rate, comparison.deltas?.frictionRate],
        ["Rework proxy", comparison.pre?.rework?.rate, comparison.post?.rework?.rate, comparison.deltas?.reworkRate],
      ];
      $("#workflow-outcomes-summary").innerHTML = `
        <div class="outcome-caveat">
          <strong>Descriptive project-window comparison</strong>
          <p>${escapeHtml(comparison.interpretation?.claim || "")} This does not establish causation.</p>
          <span>${formatNumber(comparison.coverage?.preEpisodes)} pre episodes · ${formatNumber(comparison.coverage?.postEpisodes)} post episodes · ${formatNumber(comparison.scope?.observedWindowHours)} hour symmetric window</span>
        </div>
        <div class="outcome-metrics">${metrics.map(([label, pre, post, delta]) => `
          <div class="outcome-metric">
            <span>${escapeHtml(label)}</span>
            <strong>${formatRate(pre)} → ${formatRate(post)}</strong>
            <small>${formatRateDelta(delta)} post − pre</small>
          </div>`).join("")}</div>`;
    }
    $("#workflow-outcome-list").innerHTML = (outcomes.comparisons || []).slice(0, 12).map((item) => `
      <div class="outcome-row">
        <div><strong>${escapeHtml(item.kind.replaceAll("-", " "))}</strong><span>${escapeHtml(formatDate(item.occurredAt))}</span></div>
        <span class="badge">${escapeHtml(item.status)}</span>
        <span>${formatNumber(item.coverage?.preEpisodes)} / ${formatNumber(item.coverage?.postEpisodes)} episodes</span>
      </div>`).join("") || `<div class="empty">No workflow comparisons found.</div>`;
  }
  const profiles = insights.roles?.profiles || [];
  $("#role-profiles").innerHTML = profiles.map((profile) => `
    <div class="role-row">
      <span class="role-name">${escapeHtml(profile.role)}</span>
      <div class="role-track"><i style="width:${Math.max(2, profile.autonomyChoiceRate * 100)}%"></i></div>
      <span class="role-rate">${Math.round(profile.autonomyChoiceRate * 100)}%</span>
      <span class="role-copy">${formatNumber(profile.highConfidenceSessions)} high-confidence sessions · autonomy latitude among classified boundary choices</span>
    </div>`).join("") || `<div class="empty">No role profile derived.</div>`;

  const effectiveness = insights.effectiveness;
  $("#effectiveness-result").innerHTML = effectiveness ? `
    <div class="experiment-verdict">
      <strong>Recommendation: ${escapeHtml(effectiveness.metrics?.recommendation || "inspect")}</strong>
      <p>${escapeHtml(effectiveness.claim)}</p>
    </div>
    <div class="metric-pair">
      <div class="metric-box"><span>Control tokens to gate</span><strong>${formatNumber(effectiveness.metrics?.control?.medianTokensToGate)}</strong></div>
      <div class="metric-box"><span>Treatment tokens to gate</span><strong>${formatNumber(effectiveness.metrics?.treatment?.medianTokensToGate)}</strong></div>
    </div>` : `<div class="empty">No measured experiment loaded.</div>`;
  renderCandidates();
}

function renderCandidates() {
  if (state.insightsError) {
    $("#candidate-list").innerHTML = `<div class="empty">${escapeHtml(`Insights unavailable: ${state.insightsError}`)}</div>`;
    return;
  }
  const candidates = state.insights?.refinery?.candidates || [];
  const filtered = state.candidateFilter === "all" ? candidates : candidates.filter((candidate) => candidate.type === state.candidateFilter);
  $("#candidate-list").innerHTML = filtered.slice(0, 40).map((candidate) => `
    <div class="candidate-row">
      <div><strong>${escapeHtml(candidate.title)}</strong><p>${escapeHtml(candidate.signature)}</p></div>
      <span class="badge">${escapeHtml(candidate.type)}</span>
      <span class="candidate-frequency">${formatNumber(candidate.frequency?.sessions)} sessions · ${formatNumber(candidate.frequency?.projects)} projects</span>
    </div>`).join("") || `<div class="empty">No candidates in this category.</div>`;
}

function renderSources() {
  const initials = { "claude-code": "A", codex: "O", pi: "π", "anthropic-export": "A", "openai-export": "O", "generic-jsonl": "＋" };
  $("#source-list").innerHTML = state.sources.map((source) => `
    <article class="source-card">
      <div class="source-card-head">
        <span class="source-logo">${initials[source.kind] || initials[source.id] || "◌"}</span>
        <span class="source-status ${escapeHtml(source.status)}"><span class="status-dot"></span>${escapeHtml(source.status)}</span>
      </div>
      <h3>${escapeHtml(source.label)}</h3>
      <p>${escapeHtml(source.description)}</p>
      <div class="source-meta">
        ${source.path ? `<code title="${escapeHtml(source.path)}">${escapeHtml(source.path)}</code>` : ""}
        <div class="source-domain">Domain · ${escapeHtml(source.domain)}</div>
        ${source.previewCommand ? `<div class="source-command-label">Preview without writing</div><code class="source-command" title="Run from the Chatlog checkout">${escapeHtml(source.previewCommand)}</code>` : ""}
        ${source.importCommand ? `<div class="source-command-label">Import after review</div><code class="source-command" title="Run from the Chatlog checkout">${escapeHtml(source.importCommand)}</code>` : ""}
        <p class="source-privacy">${escapeHtml(source.privacy)}</p>
      </div>
    </article>`).join("");
  $("#receipt-list").innerHTML = state.receiptError
    ? `<div class="empty">Receipt audit unavailable: ${escapeHtml(state.receiptError)}</div>`
    : state.receipts.map((receipt) => `
    <div class="receipt-row">
      <span class="timeline-dot"></span>
      <div class="receipt-copy">
        <strong>${escapeHtml(receipt.connector)} · ${escapeHtml(receipt.policy?.domain)}</strong>
        <span>${formatNumber(receipt.counts?.imported)} imported · ${formatNumber(receipt.counts?.skipped)} unchanged · ${formatNumber(receipt.counts?.turns)} turns</span>
        <code title="${escapeHtml(receipt.source?.path)}">${escapeHtml(receipt.receiptId)}</code>
      </div>
      <span class="timeline-time">${relativeTime(receipt.completedAt)}</span>
    </div>`).join("") || `<div class="empty">No completed imports have receipts yet.</div>`;
}

async function load() {
  $("#day-part").textContent = new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening";
  try {
    [state.overview, state.projects, state.sources] = await Promise.all([
      api("/api/overview"), api("/api/projects?limit=200"), api("/api/sources"),
    ]);
    try {
      state.insights = await api("/api/insights");
      state.insightsError = null;
    } catch (error) {
      state.insights = null;
      state.insightsError = error.message;
    }
    try {
      state.receipts = await api("/api/receipts?limit=20");
      state.receiptError = null;
    } catch (error) {
      state.receipts = [];
      state.receiptError = error.message;
    }
    renderOverview();
    renderProjects();
    renderInsights();
    renderSources();
  } catch (error) {
    $("#sync-copy").textContent = "Workbench error";
    $("#overview-subtitle").textContent = error.message;
  }
}

$$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-view-jump]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewJump)));
$("#mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#refresh").addEventListener("click", load);
$("#global-search").addEventListener("submit", (event) => { event.preventDefault(); runSearch($("#global-search-input").value); });
$("#recall-form").addEventListener("submit", (event) => { event.preventDefault(); runSearch($("#recall-input").value); });
$$(".query-suggestions button").forEach((button) => button.addEventListener("click", () => runSearch(button.textContent)));
$("#project-filter").addEventListener("input", (event) => renderProjects(event.target.value));
$("#close-project").addEventListener("click", () => $("#project-drawer").classList.add("hidden"));
$("#close-evidence").addEventListener("click", () => $("#evidence-dialog").close());
$("#evidence-dialog").addEventListener("click", (event) => { if (event.target === $("#evidence-dialog")) $("#evidence-dialog").close(); });
$("#close-pattern").addEventListener("click", () => $("#pattern-dialog").close());
$("#pattern-dialog").addEventListener("click", (event) => {
  if (event.target === $("#pattern-dialog")) $("#pattern-dialog").close();
});
$("#pattern-annotation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  savePatternAnnotation();
});
const patternFilterInputs = {
  query: $("#pattern-filter-query"),
  kind: $("#pattern-filter-kind"),
  signal: $("#pattern-filter-signal"),
  role: $("#pattern-filter-role"),
  harness: $("#pattern-filter-harness"),
  outcome: $("#pattern-filter-outcome"),
  review: $("#pattern-filter-review"),
  from: $("#pattern-filter-from"),
  to: $("#pattern-filter-to"),
};
Object.entries(patternFilterInputs).forEach(([name, input]) =>
  input.addEventListener(name === "query" ? "input" : "change", () => {
    state.patternFilters[name] = input.value;
    if (state.insights?.workflowPatterns)
      renderWorkflowPatterns(state.insights.workflowPatterns);
  })
);
$("#pattern-filter-reset").addEventListener("click", () => {
  for (const [name, input] of Object.entries(patternFilterInputs)) {
    input.value = name === "query" || name === "from" || name === "to"
      ? ""
      : "all";
    state.patternFilters[name] = input.value;
  }
  if (state.insights?.workflowPatterns)
    renderWorkflowPatterns(state.insights.workflowPatterns);
});
$("#candidate-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.candidateFilter = button.dataset.filter;
  $$("#candidate-filters button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  renderCandidates();
});

load();
