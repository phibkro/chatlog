const state = {
  overview: null,
  projects: [],
  insights: null,
  sources: [],
  candidateResult: null,
  candidateFilter: "all",
  candidateQuery: "",
  candidatePage: 1,
  candidatePageSize: 20,
  recallMode: "search",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
const formatNumber = (value) =>
  new Intl.NumberFormat("en", {
    notation: value > 99999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value || 0);
const formatDate = (value) => {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
};
const relativeTime = (value) => {
  if (!value) return "unknown";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size || unit === "minute")
      return formatter.format(Math.round(seconds / size), unit);
};
const shortProject = (project = "") =>
  project.replace(/^\/srv\/share\/projects\//, "").replace(/^\/tmp\//, "tmp/") || "(unknown)";
const shortHash = (value) => (value ? String(value).slice(0, 10) : "missing");

function provenanceContext(provenance) {
  if (!provenance)
    return `<span class="freshness-badge unavailable">Unavailable</span><span>No derived artifact is available.</span>`;
  if (provenance.fresh)
    return `<span class="freshness-badge fresh">Fresh</span><span>Matches corpus projection <code>${escapeHtml(shortHash(provenance.currentProjectionHash))}</code>.</span>`;
  const reason = {
    "current-projection-missing": "The current corpus projection is missing.",
    "artifact-projection-missing": "The artifact is missing projection provenance.",
    "artifact-manifest-mismatch": "The artifact and its manifest disagree.",
    "projection-mismatch": `Artifact <code>${escapeHtml(shortHash(provenance.artifactProjectionHash))}</code> does not match corpus <code>${escapeHtml(shortHash(provenance.currentProjectionHash))}</code>.`,
    "role-profile-stale": "Its role profile is stale, so this downstream result is stale too.",
    "role-profile-mismatch": `It references role profile <code>${escapeHtml(shortHash(provenance.roleProfileContentHash))}</code>, not current profile <code>${escapeHtml(shortHash(provenance.currentRoleProfileContentHash))}</code>.`,
  }[provenance.reason];
  return `<span class="freshness-badge stale">Stale</span><span>${reason || "Provenance does not match current derived state"} Re-run the relevant derivation before using this as current guidance.</span>`;
}

function evidenceLinks(evidence, label = "Evidence") {
  const pointers = Array.isArray(evidence) ? evidence : [];
  if (!pointers.length) return "";
  return `<div class="insight-evidence"><span>${escapeHtml(label)}</span>${pointers
    .map(
      (item, index) =>
        `<button type="button" class="evidence-link" data-evidence-uri="${escapeHtml(item.uri)}">Turn ${index + 1}</button>`,
    )
    .join("")}</div>`;
}

function evidenceRows(evidence, label) {
  const items = Array.isArray(evidence) ? evidence : [];
  if (!items.length) return "";
  return `<div class="evidence-group">
    <span class="evidence-group-label">${escapeHtml(label)}</span>
    ${items
      .map(
        (item) => `<div class="evidence-item">
          <button type="button" class="evidence-row" data-evidence-uri="${escapeHtml(item.uri)}">
            <span>${escapeHtml(item.snippet || "Open evidence turn")}</span><i>↗</i>
          </button>
          ${
            item.outcome || item.tools?.length
              ? `<span class="evidence-item-meta">${item.outcome ? escapeHtml(item.outcome) : ""}${item.tools?.length ? ` · ${escapeHtml(item.tools.join(", "))}` : ""}</span>`
              : ""
          }
          ${
            item.resultUri
              ? `<button type="button" class="result-evidence-link" data-evidence-uri="${escapeHtml(item.resultUri)}">Result ↗</button>`
              : ""
          }
        </div>`,
      )
      .join("")}
  </div>`;
}

const readableCategory = (value = "") => value.replaceAll("-", " ");
const desktopNavigation = window.matchMedia("(min-width: 70rem)");

function setNavigationOpen(open, { restoreFocus = false } = {}) {
  const sidebar = $("#primary-sidebar");
  const menu = $("#mobile-menu");
  const mobileOpen = !desktopNavigation.matches && open;
  sidebar.classList.toggle("open", mobileOpen);
  sidebar.inert = !desktopNavigation.matches && !mobileOpen;
  sidebar.setAttribute("aria-hidden", String(!desktopNavigation.matches && !mobileOpen));
  menu.setAttribute("aria-expanded", String(mobileOpen));
  menu.setAttribute("aria-label", mobileOpen ? "Close navigation" : "Open navigation");
  if (mobileOpen) requestAnimationFrame(() => $(".nav-item", sidebar)?.focus());
  else if (restoreFocus && !desktopNavigation.matches) menu.focus();
}

function syncNavigationMode() {
  setNavigationOpen(false);
}

async function api(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  setNavigationOpen(false, { restoreFocus: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderOverview() {
  const overview = state.overview;
  if (!overview?.ready) {
    $("#sync-copy").textContent = "Corpus not initialized";
    $("#stat-grid").innerHTML =
      `<article class="stat-card"><div class="stat-value">No corpus yet</div><div class="stat-foot">Run an ingest or import command to begin.</div></article>`;
    return;
  }
  const { corpus, harnesses, projects, recent, tools } = overview;
  $("#data-root").textContent = overview.root;
  $("#corpus-range").textContent =
    `${formatDate(corpus.firstSession)} — ${formatDate(corpus.lastSession)}`;
  $("#overview-subtitle").textContent =
    `${formatNumber(corpus.sessions)} sessions resolved across ${formatNumber(corpus.projects)} project paths.`;
  const topHarness = harnesses[0];
  const topTool = tools[0];
  const stats = [
    ["Sessions", corpus.sessions, `${formatNumber(corpus.turns)} canonical turns`, "⌁"],
    ["Projects", corpus.projects, `${shortProject(projects[0]?.project)} leads activity`, "◇"],
    [
      "Sources",
      harnesses.length,
      topHarness ? `${topHarness.harness} · ${formatNumber(topHarness.sessions)}` : "No sources",
      "◌",
    ],
    ["Top tool", topTool?.calls || 0, topTool ? `${topTool.name} calls` : "No tool data", "⌘"],
  ];
  $("#stat-grid").innerHTML = stats
    .map(
      ([label, value, foot, icon]) => `
    <article class="stat-card">
      <div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon}</span></div>
      <div class="stat-value">${formatNumber(value)}</div>
      <div class="stat-foot">${escapeHtml(foot)}</div>
    </article>`,
    )
    .join("");

  $("#recent-sessions").innerHTML =
    recent
      .map(
        (session) => `
    <div class="timeline-row">
      <span class="timeline-dot"></span>
      <div class="timeline-copy">
        <strong>${escapeHtml(session.title || shortProject(session.project))}</strong>
        <span>${escapeHtml(session.harness)} · ${formatNumber(session.turns)} turns · <span class="badge ${escapeHtml(session.domain)}">${escapeHtml(session.domain)}</span></span>
      </div>
      <span class="timeline-time">${relativeTime(session.endedAt)}</span>
    </div>`,
      )
      .join("") || `<div class="empty">No sessions found.</div>`;

  const maximum = Math.max(...projects.map((project) => Number(project.sessions)), 1);
  $("#project-focus").innerHTML = projects
    .slice(0, 6)
    .map(
      (project) => `
    <div class="focus-row">
      <strong>${escapeHtml(shortProject(project.project))}</strong>
      <span>${formatNumber(project.sessions)} sessions</span>
      <div class="focus-track"><i style="width:${Math.max(3, (Number(project.sessions) / maximum) * 100)}%"></i></div>
    </div>`,
    )
    .join("");
}

function renderProjects(filter = "") {
  const term = filter.toLowerCase();
  const projects = state.projects.filter((project) => project.project.toLowerCase().includes(term));
  $("#project-count").textContent = `${projects.length} projects`;
  $("#project-list").innerHTML =
    projects
      .map(
        (project) => `
    <article class="project-card" data-project="${escapeHtml(project.project)}">
      <div class="project-card-head"><span class="project-symbol">◇</span><span class="badge">${relativeTime(project.lastSeen)}</span></div>
      <h3 title="${escapeHtml(project.project)}">${escapeHtml(shortProject(project.project))}</h3>
      <p>${formatNumber(project.sessions)} sessions · ${formatNumber(project.turns)} turns</p>
    </article>`,
      )
      .join("") || `<div class="empty spacious">No matching projects.</div>`;
  $$(".project-card").forEach((card) =>
    card.addEventListener("click", () => openProject(card.dataset.project)),
  );
}

async function openProject(project) {
  const drawer = $("#project-drawer");
  $("#project-drawer-title").textContent = shortProject(project);
  $("#project-intelligence").innerHTML =
    `<div class="empty">Loading current project intelligence…</div>`;
  drawer.classList.remove("hidden");
  drawer.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const result = await api(
      `/api/project-intelligence?project=${encodeURIComponent(project)}&sampleLimit=24&sessionLimit=40`,
    );
    const outcomeTotal = Object.values(result.outcomes).reduce(
      (total, count) => total + Number(count),
      0,
    );
    const outcomes = ["success", "failure", "mixed", "unknown"]
      .map(
        (status) => `<div class="project-stat outcome-${status}">
          <span>${escapeHtml(status)}</span><strong>${formatNumber(result.outcomes[status])}</strong>
        </div>`,
      )
      .join("");
    const problemRows =
      result.recurringProblems
        .map(
          (problem) => `<article class="project-finding">
            <div><strong>${escapeHtml(readableCategory(problem.category))}</strong>
            <span>${formatNumber(problem.sessions)} sampled sessions · ${formatNumber(problem.occurrences)} occurrences</span></div>
            ${problem.examples
              .map((example) => evidenceRows([example.evidence], example.outcome))
              .join("")}
          </article>`,
        )
        .join("") || `<div class="empty">No categorized problems in the derived sample.</div>`;
    const decisions =
      result.recentDecisions
        .map(
          (decision) => `<article class="project-decision">
            <span>${formatDate(decision.endedAt)} · ${escapeHtml(decision.harness)} · ${escapeHtml(decision.model)}</span>
            ${evidenceRows([decision.evidence], "Decision")}
          </article>`,
        )
        .join("") || `<div class="empty">No recent decision evidence in the sample.</div>`;
    const models =
      result.models
        .map(
          (model) => `<div class="mix-row"><strong>${escapeHtml(model.model)}</strong><span>${escapeHtml(model.harness)} · ${formatNumber(model.sessions)} sessions</span></div>`,
        )
        .join("") || `<div class="empty">No model activity.</div>`;
    const tools =
      result.tools
        .map(
          (tool) => `<div class="mix-row"><strong>${escapeHtml(tool.tool)}</strong><span>${formatNumber(tool.calls)} calls · ${formatNumber(tool.sessions)} sessions</span></div>`,
        )
        .join("") || `<div class="empty">No assistant tool calls.</div>`;
    const sessions =
      result.sessions
        .map(
          (session) => `
      <div class="session-row">
        <div><strong>${escapeHtml(session.title || session.id)}</strong><span>${escapeHtml(session.model)}</span></div>
        <span>${escapeHtml(session.harness)}</span>
        <span>${formatNumber(session.turns)} turns</span>
        <span>${relativeTime(session.endedAt)}</span>
      </div>`,
        )
        .join("") || `<div class="empty">No current sessions found.</div>`;
    $("#project-intelligence").innerHTML = `
      <div class="project-scope">Current projection · ${formatNumber(result.overview.sessions)} sessions total · derived sample ${formatNumber(result.scope.derivedSessions)}/${formatNumber(result.scope.sampledCurrentSessions)}${result.scope.derivedMissing ? ` · ${formatNumber(result.scope.derivedMissing)} missing derived` : ""} · no egress</div>
      <section class="project-section">
        <div class="project-section-heading"><div><p class="eyebrow">Recent derived sample</p><h3>Outcome mix</h3></div><span>${formatNumber(outcomeTotal)} classified sessions</span></div>
        <div class="project-outcomes">${outcomes}</div>
      </section>
      <section class="project-section">
        <div class="project-section-heading"><div><p class="eyebrow">Recurring friction</p><h3>Problem categories</h3></div><span>maximum 10</span></div>
        <div class="project-findings">${problemRows}</div>
      </section>
      <section class="project-section">
        <div class="project-section-heading"><div><p class="eyebrow">Evidence-backed choices</p><h3>Recent decisions</h3></div><span>maximum 10</span></div>
        <div class="project-decisions">${decisions}</div>
      </section>
      <div class="project-mix-grid">
        <section class="project-section"><div class="project-section-heading"><div><p class="eyebrow">Top models · exact current counts</p><h3>Model mix</h3></div><span>maximum 8</span></div>${models}</section>
        <section class="project-section"><div class="project-section-heading"><div><p class="eyebrow">Top tools · exact current counts</p><h3>Tool mix</h3></div><span>maximum 10</span></div>${tools}</section>
      </div>
      <section class="project-section">
        <div class="project-section-heading"><div><p class="eyebrow">Current projection</p><h3>Sessions</h3></div><span>showing ${formatNumber(result.sessions.length)}</span></div>
        <div class="session-table">${sessions}</div>
      </section>`;
  } catch (error) {
    $("#project-intelligence").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
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
    $("#result-meta").textContent =
      `${result.hits.length} ranked turn matches · local lexical search · no egress`;
    $("#search-results").innerHTML =
      result.hits
        .map((hit) => {
          const snippet = escapeHtml(hit.snippet)
            .replaceAll("&lt;mark&gt;", "<mark>")
            .replaceAll("&lt;/mark&gt;", "</mark>");
          return `<article class="search-hit" data-uri="${escapeHtml(hit.evidenceUri)}">
        <span class="hit-accent"></span>
        <div>
          <div class="hit-head"><strong>${escapeHtml(hit.title || shortProject(hit.project))}</strong><span class="badge">${escapeHtml(hit.harness)}</span><span class="badge ${escapeHtml(hit.domain)}">${escapeHtml(hit.domain)}</span></div>
          <p class="hit-snippet">${snippet}</p>
          <div class="hit-pointer">${escapeHtml(hit.evidenceUri)}</div>
        </div>
        <span class="hit-score">${Number(hit.score).toFixed(2)}</span>
      </article>`;
        })
        .join("") ||
      `<div class="empty spacious">No matching evidence. Try fewer or broader terms.</div>`;
    $$(".search-hit").forEach((hit) =>
      hit.addEventListener("click", () => openEvidence(hit.dataset.uri)),
    );
  } catch (error) {
    $("#result-meta").textContent = "Search failed";
    $("#search-results").innerHTML =
      `<div class="empty spacious">${escapeHtml(error.message)}</div>`;
  }
}

async function runPriorAttempts(question) {
  const input = question.trim();
  if (!input) return;
  showView("recall");
  $("#recall-input").value = input;
  $("#result-meta").textContent = "Finding prior attempts in current local sessions…";
  $("#search-results").innerHTML = `<div class="empty spacious">Building the attempt timeline…</div>`;
  try {
    const result = await api(`/api/prior-attempts?q=${encodeURIComponent(input)}&limit=8`);
    $("#result-meta").textContent =
      `${result.sessions.length} current sessions · chronological · local lexical analysis · no egress`;
    $("#search-results").innerHTML =
      result.sessions
        .map(
          (session) => `<article class="attempt-card">
            <div class="attempt-head">
              <div><span>${formatDate(session.endedAt)}</span><h3>${escapeHtml(shortProject(session.project))}</h3></div>
              <div><span class="badge">${escapeHtml(session.harness)}</span><span class="badge">${escapeHtml(session.model)}</span><span class="outcome-badge ${escapeHtml(session.outcome)}">${escapeHtml(session.outcome)}</span></div>
            </div>
            ${evidenceRows(session.matchedEvidence, "Lexical match")}
            ${evidenceRows(session.problems, "Problem")}
            ${evidenceRows(session.attempts, "Attempt")}
            ${evidenceRows(session.decisions, "Decision")}
            ${evidenceRows(session.resolutions, "Resolution")}
          </article>`,
        )
        .join("") ||
      `<div class="empty spacious">No current user or assistant session matched this topic.</div>`;
  } catch (error) {
    $("#result-meta").textContent = "Prior Attempts failed";
    $("#search-results").innerHTML =
      `<div class="empty spacious">${escapeHtml(error.message)}</div>`;
  }
}

function runRecall(query) {
  return state.recallMode === "attempts" ? runPriorAttempts(query) : runSearch(query);
}

function setRecallMode(mode) {
  state.recallMode = mode;
  $$("#recall-mode button").forEach((button) =>
    button.classList.toggle("active", button.dataset.mode === mode),
  );
  const attempts = mode === "attempts";
  $("#recall-label").textContent = attempts
    ? "What did we try last time?"
    : "What are you trying to remember?";
  $("#recall-input").placeholder = attempts
    ? "What did we try last time for projection drift?"
    : "What did we learn about Nix flake source visibility?";
  $("#recall-submit").innerHTML = attempts
    ? "Build attempt timeline <span>→</span>"
    : "Search history <span>→</span>";
}

async function openEvidence(uri) {
  const dialog = $("#evidence-dialog");
  $("#evidence-content").textContent = "Loading canonical turn…";
  dialog.showModal();
  try {
    const evidence = await api(`/api/evidence?uri=${encodeURIComponent(uri)}`);
    $("#evidence-title").textContent = evidence.title || shortProject(evidence.project);
    $("#evidence-meta").innerHTML = [
      evidence.harness,
      evidence.domain,
      `turn ${evidence.turnIndex}`,
      evidence.project,
    ]
      .map((item) => `<span class="badge">${escapeHtml(item)}</span>`)
      .join("");
    $("#evidence-content").textContent =
      evidence.turn.content || `[${evidence.turn.role} turn with no textual content]`;
  } catch (error) {
    $("#evidence-content").textContent = error.message;
  }
}

function renderInsights() {
  const insights = state.insights || {};
  const orchestration = insights.orchestration;
  $("#orchestration-provenance").innerHTML = provenanceContext(orchestration?.provenance);
  $("#orchestration-claim").textContent = orchestration
    ? orchestration.provenance?.fresh
      ? orchestration.claim
      : `Historical finding: ${orchestration.claim}`
    : "No orchestration profile has been derived yet.";
  $("#orchestration-evidence").innerHTML = evidenceLinks(orchestration?.evidence);

  const roles = insights.roles;
  $("#roles-provenance").innerHTML = provenanceContext(roles?.provenance);
  const profiles = insights.roles?.profiles || [];
  $("#role-profiles").innerHTML =
    profiles
      .map(
        (profile) => `
    <div class="role-row ${roles?.provenance?.fresh ? "" : "stale-insight"}">
      <span class="role-name">${escapeHtml(profile.role)}</span>
      <div class="role-track"><i style="width:${Math.max(2, profile.autonomyChoiceRate * 100)}%"></i></div>
      <span class="role-rate">${Math.round(profile.autonomyChoiceRate * 100)}%</span>
      <span class="role-copy">${roles?.provenance?.fresh ? "" : "Historical · "}${formatNumber(profile.highConfidenceSessions)} high-confidence sessions · autonomy latitude among classified boundary choices</span>
      ${evidenceLinks(profile.evidence)}
    </div>`,
      )
      .join("") || `<div class="empty">No role profile derived.</div>`;

  const effectiveness = insights.effectiveness;
  $("#effectiveness-provenance").innerHTML = provenanceContext(effectiveness?.provenance);
  $("#effectiveness-result").innerHTML = effectiveness
    ? `
    <div class="experiment-verdict ${effectiveness.provenance?.fresh ? "" : "stale-insight"}">
      <strong>${
        effectiveness.provenance?.fresh
          ? `Recommendation: ${escapeHtml(effectiveness.metrics?.recommendation || "inspect")}`
          : "Historical result — not current guidance"
      }</strong>
      <p>${escapeHtml(effectiveness.claim)}</p>
    </div>
    <div class="metric-pair">
      <div class="metric-box"><span>Control tokens to gate</span><strong>${formatNumber(effectiveness.metrics?.control?.medianTokensToGate)}</strong></div>
      <div class="metric-box"><span>Treatment tokens to gate</span><strong>${formatNumber(effectiveness.metrics?.treatment?.medianTokensToGate)}</strong></div>
    </div>
    ${evidenceLinks(effectiveness.evidence)}`
    : `<div class="empty">No measured experiment loaded.</div>`;
  $("#refinery-provenance").innerHTML = provenanceContext(
    state.candidateResult?.provenance ?? insights.refinery?.provenance,
  );
  renderCandidates();
}

function precisionGateContext(gate) {
  if (!gate)
    return `<strong>Documentation-gap classification unavailable</strong><span>No recorded operator-judged precision result is available. Candidates are possible review leads only.</span>`;
  return `<strong>Documentation-gap classification unavailable</strong><span>${escapeHtml(gate.message)}</span><small>Required precision: ${formatNumber(gate.minimumOperatorJudgedPrecisionPercent)}% · recorded: none</small>`;
}

function renderCandidates() {
  const result = state.candidateResult;
  const candidates = result?.items || [];
  const refineryFresh = result?.provenance?.fresh;
  $("#knowledge-precision-gate").innerHTML = precisionGateContext(result?.precisionGate);
  $("#refinery-provenance").innerHTML = provenanceContext(result?.provenance);
  $("#candidate-result-meta").textContent = result
    ? `${formatNumber(result.pagination.total)} possible review leads · server-filtered · no egress`
    : "Loading bounded candidate index…";
  $("#candidate-list").innerHTML =
    candidates
      .map(
        (candidate) => `
    <button type="button" class="candidate-row ${refineryFresh ? "" : "stale-insight"}" data-candidate-id="${escapeHtml(candidate.id)}">
      <div><strong>${refineryFresh ? "" : "Historical · "}${escapeHtml(candidate.title)}</strong><p>${escapeHtml(candidate.signature)}</p><small>${escapeHtml(candidate.reviewNotice)}</small></div>
      <span class="badge">${escapeHtml(candidate.type)}</span>
      <span class="candidate-frequency">${formatNumber(candidate.frequency?.sessions)} sessions · ${formatNumber(candidate.frequency?.projects)} projects</span>
    </button>`,
      )
      .join("") || `<div class="empty">No possible review leads match these filters.</div>`;
  const pagination = result?.pagination;
  $("#candidate-page").textContent = pagination
    ? `Page ${formatNumber(pagination.page)} of ${formatNumber(pagination.totalPages || 1)}`
    : "Page 1";
  $("#candidate-previous").disabled = !pagination || pagination.page <= 1;
  $("#candidate-next").disabled =
    !pagination || pagination.totalPages === 0 || pagination.page >= pagination.totalPages;
}

async function loadCandidates() {
  $("#candidate-result-meta").textContent = "Loading bounded candidate index…";
  const params = new URLSearchParams({
    q: state.candidateQuery,
    type: state.candidateFilter,
    page: String(state.candidatePage),
    pageSize: String(state.candidatePageSize),
  });
  try {
    state.candidateResult = await api(`/api/knowledge-candidates?${params}`);
    renderCandidates();
  } catch (error) {
    $("#candidate-result-meta").textContent = "Candidate review failed";
    $("#candidate-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function detailField(label, value) {
  if (value == null || value === "") return "";
  return `<div class="candidate-detail-field"><span>${escapeHtml(label)}</span><p>${escapeHtml(value)}</p></div>`;
}

async function openCandidate(id) {
  const drawer = $("#candidate-drawer");
  $("#candidate-drawer-title").textContent = "Review candidate";
  $("#candidate-detail").innerHTML = `<div class="empty">Loading read-only detail…</div>`;
  drawer.classList.remove("hidden");
  drawer.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const detail = await api(`/api/knowledge-candidate?id=${encodeURIComponent(id)}`);
    const candidate = detail.candidate;
    const frequency = candidate.frequency || {};
    const artifact = detail.artifact || {};
    $("#candidate-drawer-title").textContent = candidate.title;
    $("#candidate-detail").innerHTML = `
      <div class="candidate-review-notice">${escapeHtml(detail.reviewNotice)}</div>
      <div class="provenance">${provenanceContext(detail.provenance)}</div>
      <div class="precision-gate">${precisionGateContext(detail.precisionGate)}</div>
      <div class="candidate-detail-meta">
        <span class="badge">${escapeHtml(candidate.type)}</span>
        <span class="badge">${escapeHtml(candidate.status)}</span>
        <span>Auto-promotion disabled · no write actions</span>
      </div>
      ${detailField("Signature", candidate.signature)}
      <section class="candidate-detail-section">
        <p class="eyebrow">Observed frequency · signal, not decision</p>
        <div class="candidate-frequency-grid">
          ${[
            ["Occurrences", frequency.occurrences],
            ["Distinct wording", frequency.distinctSnippets],
            ["Conversations", frequency.conversations],
            ["Sessions", frequency.sessions],
            ["Projects", frequency.projects],
            ["Harnesses", frequency.harnesses],
            ["Threshold", frequency.threshold],
          ]
            .map(
              ([label, value]) =>
                `<div><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong></div>`,
            )
            .join("")}
        </div>
      </section>
      <section class="candidate-detail-section">
        <p class="eyebrow">Artifact provenance · opaque metadata</p>
        ${detailField("Artifact content hash", artifact.contentHash || "Unavailable")}
        ${detailField("Input projection hash", artifact.inputProjectionHash || "Unavailable")}
        ${detailField("Recipe hash", artifact.recipeHash || "Unavailable")}
        ${detailField("Processed at", formatDate(artifact.processedAt))}
      </section>
      <section class="candidate-detail-section">
        <p class="eyebrow">Curation route · not executed</p>
        ${detailField("Principle", candidate.curation?.principle)}
        ${detailField("Route", candidate.curation?.route)}
        <ul>${(candidate.curation?.checks || []).map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul>
      </section>
      <section class="candidate-detail-section">
        <p class="eyebrow">Evaluation metadata · ${escapeHtml(candidate.evaluation?.status || "unmeasured")}</p>
        ${detailField("Contract", candidate.evaluation?.contract)}
        ${detailField("Minimum runs per arm", candidate.evaluation?.minimumRunsPerArm)}
        ${detailField("Control", candidate.evaluation?.control)}
        ${detailField("Treatment", candidate.evaluation?.treatment)}
        ${detailField("Metrics", (candidate.evaluation?.metrics || []).join(", "))}
        ${detailField("Keep rule", candidate.evaluation?.keepRule)}
        ${detailField("Cut rule", candidate.evaluation?.cutRule)}
      </section>
      <section class="candidate-detail-section">
        <p class="eyebrow">Canonical evidence pointers · maximum ${formatNumber(detail.bounds.evidencePointers)}</p>
        ${evidenceLinks(candidate.evidence, "Open canonical turn")}
      </section>`;
  } catch (error) {
    $("#candidate-detail").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadThemes() {
  const button = $("#load-themes");
  button.disabled = true;
  button.textContent = "Reading completed cache…";
  $("#themes-content").innerHTML =
    `<div class="empty">Computing exact current-key coverage without extraction…</div>`;
  try {
    const result = await api("/api/themes?limit=20");
    const coverage = result.coverage || {};
    const cache = result.cache || {};
    const distribution = result.distribution;
    const coverageCopy = coverage.exact
      ? `${formatNumber(coverage.currentCovered)} of ${formatNumber(coverage.currentDenominator)} current conversations · ${formatNumber(coverage.percent)}%`
      : `Coverage is not exact (${escapeHtml(coverage.reason || "unavailable")}); no corpus-wide conclusion is shown.`;
    const variants =
      (result.variants || [])
        .map(
          (variant) => `<div class="theme-variant">
            <strong>${escapeHtml(variant.model)}</strong>
            <code>${escapeHtml(variant.recipe)}</code>
            <span>${variant.currentCovered == null ? "current coverage unavailable" : `${formatNumber(variant.currentCovered)}/${formatNumber(coverage.currentDenominator)} current · ${formatNumber(variant.coveragePercent)}%`}</span>
          </div>`,
        )
        .join("") || `<div class="empty">No completed cache variants found.</div>`;
    const clusters =
      (result.clusters || [])
        .map(
          (cluster) => `<div class="theme-cluster">
            <div><strong>${escapeHtml(readableCategory(cluster.topic))}</strong><span>${formatNumber(cluster.conversations)} covered conversations</span></div>
            <small>${escapeHtml((cluster.members || []).join(" · "))}</small>
          </div>`,
        )
        .join("") ||
      (coverage.exact
        ? `<div class="empty">No clusters are available for the current completed-cache sample.</div>`
        : `<div class="empty">Clusters are withheld because coverage or clustering is not exact.</div>`);
    $("#themes-content").innerHTML = `
      <div class="themes-warning">
        <strong>${escapeHtml(result.label)}</strong>
        <span>Cached sample only. No extraction, network request, or cache write was performed.</span>
      </div>
      <div class="themes-coverage ${coverage.exact ? "" : "not-exact"}">
        <span>${coverage.exact ? "Exact current cache-key coverage" : "Coverage unavailable"}</span>
        <strong>${coverageCopy}</strong>
      </div>
      <div class="themes-stats">
        <div><span>Completed cache entries</span><strong>${cache.totalCompletedEntries == null ? "Unknown" : formatNumber(cache.totalCompletedEntries)}</strong></div>
        <div><span>Stale / other</span><strong>${cache.staleOtherEntries == null ? "Unknown" : formatNumber(cache.staleOtherEntries)}</strong></div>
        <div><span>Invalid</span><strong>${cache.invalidEntries == null ? "Unknown" : formatNumber(cache.invalidEntries)}</strong></div>
        <div><span>Shared clusters</span><strong>${distribution ? formatNumber(distribution.sharedClusters) : "Unknown"}</strong></div>
        <div><span>Singleton long tail</span><strong>${distribution ? formatNumber(distribution.singletonLongTailClusters) : "Unknown"}</strong></div>
      </div>
      <section class="themes-section">
        <div class="themes-section-head"><div><p class="eyebrow">Observed model + recipe variants</p><h3>Cache provenance</h3></div><code>${escapeHtml(result.clusterRecipe)}</code></div>
        <div class="theme-variants">${variants}</div>
      </section>
      <section class="themes-section">
        <div class="themes-section-head"><div><p class="eyebrow">Bounded deterministic clusters</p><h3>Top cached themes</h3></div><span>maximum ${formatNumber(result.bounds.requestedClusterLimit)}</span></div>
        <div class="theme-clusters">${clusters}</div>
      </section>`;
  } catch (error) {
    $("#themes-content").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Reload cached themes →";
  }
}

function renderSources() {
  const initials = {
    "claude-code": "A",
    codex: "O",
    pi: "π",
    "anthropic-export": "A",
    "openai-export": "O",
    "generic-jsonl": "＋",
  };
  $("#source-list").innerHTML = state.sources
    .map(
      (source) => `
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
    </article>`,
    )
    .join("");
}

async function load() {
  $("#day-part").textContent =
    new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening";
  try {
    [state.overview, state.projects, state.insights, state.sources, state.candidateResult] =
      await Promise.all([
        api("/api/overview"),
        api("/api/projects?limit=200"),
        api("/api/insights?candidateLimit=0"),
        api("/api/sources"),
        api(
          `/api/knowledge-candidates?type=${encodeURIComponent(state.candidateFilter)}&page=1&pageSize=${state.candidatePageSize}`,
        ),
      ]);
    state.candidatePage = 1;
    renderOverview();
    renderProjects();
    renderInsights();
    renderSources();
  } catch (error) {
    $("#sync-copy").textContent = "Workbench error";
    $("#overview-subtitle").textContent = error.message;
  }
}

$$(".nav-item").forEach((button) =>
  button.addEventListener("click", () => showView(button.dataset.view)),
);
$$("[data-view-jump]").forEach((button) =>
  button.addEventListener("click", () => showView(button.dataset.viewJump)),
);
$("#mobile-menu").addEventListener("click", () =>
  setNavigationOpen(!$("#primary-sidebar").classList.contains("open"), { restoreFocus: true }),
);
$("#refresh").addEventListener("click", load);
$("#global-search").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch($("#global-search-input").value);
});
$("#recall-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runRecall($("#recall-input").value);
});
$$(".query-suggestions button").forEach((button) =>
  button.addEventListener("click", () => runRecall(button.textContent)),
);
$("#recall-mode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (button) setRecallMode(button.dataset.mode);
});
$("#project-filter").addEventListener("input", (event) => renderProjects(event.target.value));
$("#close-project").addEventListener("click", () => $("#project-drawer").classList.add("hidden"));
$("#close-candidate").addEventListener("click", () =>
  $("#candidate-drawer").classList.add("hidden"),
);
$("#load-themes").addEventListener("click", loadThemes);
$("#close-evidence").addEventListener("click", () => $("#evidence-dialog").close());
$("#evidence-dialog").addEventListener("click", (event) => {
  if (event.target === $("#evidence-dialog")) $("#evidence-dialog").close();
});
document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-evidence-uri]");
  if (link) openEvidence(link.dataset.evidenceUri);
  if (
    $("#primary-sidebar").classList.contains("open") &&
    !event.target.closest("#primary-sidebar") &&
    !event.target.closest("#mobile-menu")
  )
    setNavigationOpen(false, { restoreFocus: true });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#primary-sidebar").classList.contains("open")) {
    event.preventDefault();
    setNavigationOpen(false, { restoreFocus: true });
  }
});
desktopNavigation.addEventListener("change", syncNavigationMode);
$("#candidate-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.candidateFilter = button.dataset.filter;
  state.candidatePage = 1;
  $$("#candidate-filters button").forEach((candidate) =>
    candidate.classList.toggle("active", candidate === button),
  );
  loadCandidates();
});
$("#candidate-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.candidateQuery = $("#candidate-search").value.trim();
  state.candidatePage = 1;
  loadCandidates();
});
$("#candidate-previous").addEventListener("click", () => {
  if (state.candidatePage <= 1) return;
  state.candidatePage--;
  loadCandidates();
});
$("#candidate-next").addEventListener("click", () => {
  if (state.candidatePage >= (state.candidateResult?.pagination?.totalPages || 0)) return;
  state.candidatePage++;
  loadCandidates();
});
$("#candidate-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-candidate-id]");
  if (row) openCandidate(row.dataset.candidateId);
});

syncNavigationMode();
load();
