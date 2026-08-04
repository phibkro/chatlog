const state = {
  overview: null,
  projects: [],
  insights: null,
  insightsError: null,
  sources: [],
  receipts: [],
  receiptError: null,
  sourceReceipts: [],
  sourceReceiptError: null,
  nominations: [],
  nominationError: null,
  candidateResult: null,
  candidateFilter: "all",
  candidateQuery: "",
  candidatePage: 1,
  candidatePageSize: 20,
  recallMode: "search",
  context: null,
  contextError: null,
  contextLoading: true,
  contextFeedback: {},
  contextOutcome: {},
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
const WORKBENCH_BOOTSTRAP_PREFIX = "#chatlog-workbench=";

function clearBootstrapFragment() {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function bootstrapWorkbench() {
  const fragment = window.location.hash;
  if (!fragment.startsWith(WORKBENCH_BOOTSTRAP_PREFIX)) return;
  const credential = fragment.slice(WORKBENCH_BOOTSTRAP_PREFIX.length);
  clearBootstrapFragment();
  if (!/^[A-Za-z0-9_-]+$/u.test(credential)) return;
  try {
    await fetch("/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${credential}` },
    });
  } catch {
    // The regular API load reports an unavailable workbench without exposing credentials.
  }
}

function setNavigationOpen(open, { restoreFocus = false } = {}) {
  const sidebar = $("#primary-sidebar");
  const menu = $("#mobile-menu");
  const page = $("main");
  const wasOpen = sidebar.classList.contains("open");
  const mobileOpen = !desktopNavigation.matches && open;
  sidebar.classList.toggle("open", mobileOpen);
  sidebar.inert = !desktopNavigation.matches && !mobileOpen;
  page.inert = mobileOpen;
  sidebar.setAttribute("aria-hidden", String(!desktopNavigation.matches && !mobileOpen));
  menu.setAttribute("aria-expanded", String(mobileOpen));
  menu.setAttribute("aria-label", mobileOpen ? "Close navigation" : "Open navigation");
  if (mobileOpen) requestAnimationFrame(() => $(".nav-item", sidebar)?.focus());
  else if (restoreFocus && wasOpen && !desktopNavigation.matches) menu.focus();
}

function syncNavigationMode() {
  setNavigationOpen(false);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin" });
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
    $("#data-root").textContent = overview?.root || "Local data root unavailable";
    $("#corpus-range").textContent = "No local corpus";
    $("#overview-subtitle").textContent =
      "Run chatlog ingest to build the first local evidence corpus.";
    $("#recent-sessions").innerHTML =
      `<div class="empty">No sessions yet. Ingest configured provider histories to begin.</div>`;
    $("#project-focus").innerHTML =
      `<div class="empty">Project activity appears after the first ingest.</div>`;
    $("#sync-copy").textContent = "Corpus not initialized";
    $("#stat-grid").innerHTML =
      `<article class="stat-card"><div class="stat-value">No corpus yet</div><div class="stat-foot">Run <code>chatlog ingest</code>, then reload this page.</div></article>`;
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
          (model) =>
            `<div class="mix-row"><strong>${escapeHtml(model.model)}</strong><span>${escapeHtml(model.harness)} · ${formatNumber(model.sessions)} sessions</span></div>`,
        )
        .join("") || `<div class="empty">No model activity.</div>`;
    const tools =
      result.tools
        .map(
          (tool) =>
            `<div class="mix-row"><strong>${escapeHtml(tool.tool)}</strong><span>${formatNumber(tool.calls)} calls · ${formatNumber(tool.sessions)} sessions</span></div>`,
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
  $("#search-results").innerHTML =
    `<div class="empty spacious">Building the attempt timeline…</div>`;
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
  if (state.insightsError) {
    const message = `Insights unavailable: ${state.insightsError}`;
    const unavailable = `<span class="freshness-badge unavailable">Unavailable</span><span>${escapeHtml(state.insightsError)}</span>`;
    $("#orchestration-provenance").innerHTML = unavailable;
    $("#roles-provenance").innerHTML = unavailable;
    $("#effectiveness-provenance").innerHTML = unavailable;
    $("#orchestration-claim").textContent = message;
    $("#role-profiles").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    $("#effectiveness-result").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    renderCandidates();
    return;
  }
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
  if (state.candidateError) {
    $("#knowledge-precision-gate").innerHTML = precisionGateContext(null);
    $("#refinery-provenance").innerHTML = provenanceContext(null);
    $("#candidate-result-meta").textContent = "Candidate review failed";
    $("#candidate-list").innerHTML = `<div class="empty">${escapeHtml(state.candidateError)}</div>`;
    $("#candidate-page").textContent = "Page 1";
    $("#candidate-previous").disabled = true;
    $("#candidate-next").disabled = true;
    return;
  }
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
    state.candidateError = null;
  } catch (error) {
    state.candidateResult = null;
    state.candidateError = error.message;
  }
  renderCandidates();
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
        ${
          source.lastReceiptSummary
            ? `
          <div class="source-receipt-summary">
            <div class="source-command-label">Last source receipt</div>
            <code title="${escapeHtml(source.lastReceiptSummary.receiptHash)}">${escapeHtml(source.lastReceiptSummary.receiptHash)}</code>
            <span>${formatNumber(source.lastReceiptSummary.itemCounts?.sourceItems ?? 0)} source items · ${formatNumber(source.lastReceiptSummary.itemCounts?.opaqueItems ?? 0)} opaque · ${formatNumber(source.lastReceiptSummary.itemCounts?.policyOmissions ?? 0)} omissions${source.lastReceiptSummary.partialTail ? " · partial tail" : ""}</span>
            <span>${escapeHtml(source.lastReceiptSummary.eventBatchHash)} batch · ${escapeHtml(source.lastReceiptSummary.conversationProjectionHash)} projection</span>
            <span>Losses · ${escapeHtml(JSON.stringify(source.lastReceiptSummary.lossCounts || {}))}</span>
          </div>`
            : ""
        }
      </div>
    </article>`,
    )
    .join("");
  $("#receipt-list").innerHTML = state.receiptError
    ? `<div class="empty">Receipt audit unavailable: ${escapeHtml(state.receiptError)}</div>`
    : state.receipts
        .map(
          (receipt) => `
    <div class="receipt-row">
      <span class="timeline-dot"></span>
      <div class="receipt-copy">
        <strong>${escapeHtml(receipt.connector)} · ${escapeHtml(receipt.policy?.domain)}</strong>
        <span>${formatNumber(receipt.counts?.imported)} imported · ${formatNumber(receipt.counts?.skipped)} unchanged · ${formatNumber(receipt.counts?.turns)} turns</span>
        <code title="${escapeHtml(receipt.source?.path)}">${escapeHtml(receipt.receiptId)}</code>
      </div>
      <span class="timeline-time">${relativeTime(receipt.completedAt)}</span>
    </div>`,
        )
        .join("") || `<div class="empty">No completed imports have receipts yet.</div>`;
  const sourceAudit = state.sourceReceiptError
    ? `<div class="empty">Source receipt audit unavailable: ${escapeHtml(state.sourceReceiptError)}</div>`
    : state.sourceReceipts.length
      ? (() => {
          const totals = state.sourceReceipts.reduce(
            (sum, receipt) => ({
              sourceItems: sum.sourceItems + (receipt.itemCounts?.sourceItems || 0),
              opaque: sum.opaque + (receipt.itemCounts?.opaqueItems || 0),
              omissions: sum.omissions + (receipt.itemCounts?.policyOmissions || 0),
              partialTails: sum.partialTails + (receipt.partialTail ? 1 : 0),
            }),
            { sourceItems: 0, opaque: 0, omissions: 0, partialTails: 0 },
          );
          return `<div class="receipt-row source-receipt-aggregate">
          <span class="timeline-dot"></span>
          <div class="receipt-copy">
            <strong>Source receipt aggregate</strong>
            <span>${formatNumber(totals.sourceItems)} source items · ${formatNumber(totals.opaque)} opaque · ${formatNumber(totals.omissions)} omissions · ${formatNumber(totals.partialTails)} partial tails</span>
            <code>${formatNumber(state.sourceReceipts.length)} immutable receipts</code>
          </div>
        </div>`;
        })()
      : `<div class="empty">No source receipts have been persisted yet.</div>`;
  const nominationAudit = state.nominationError
    ? `<div class="empty">Nomination audit unavailable: ${escapeHtml(state.nominationError)}</div>`
    : `<div class="receipt-row nomination-aggregate">
        <span class="timeline-dot"></span>
        <div class="receipt-copy">
          <strong>Unknown-shape nominations</strong>
          <span>${formatNumber(state.nominations.length)} bounded maintenance nominations</span>
        </div>
      </div>`;
  $("#receipt-list").insertAdjacentHTML("beforeend", `${sourceAudit}${nominationAudit}`);
}

const CONTEXT_EVENT_LABELS = {
  "context.bundle.proposed": "Bundle proposed",
  "context.bundle.rendered": "Bundle rendered",
  "context.bundle.emitted": "Bundle emitted",
  "context.bundle.acknowledged": "Provider acknowledgment",
  "context.recall.returned": "Recall returned",
  "context.procedure.returned": "Procedure returned",
  "context.delivery.failed": "Delivery failed",
  "context.feedback.asserted": "Feedback recorded",
  "context.outcome.observed": "Outcome observed",
};

const CONTEXT_FEEDBACK_OPTIONS = [
  ["helpful", "Helpful"],
  ["harmful", "Harmful"],
  ["stale", "Stale"],
  ["mis-scoped", "Mis-scoped"],
  ["irrelevant", "Irrelevant"],
  ["incorrect", "Incorrect"],
];

const CONTEXT_TREATMENT_OPTIONS = [
  ["no-memory", "No memory"],
  ["raw-evidence", "Raw evidence"],
  ["active-insight", "Active insight"],
  ["insight-plus-procedure", "Insight plus procedure"],
  ["reflective-model", "Reflective model"],
];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValues(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function finiteContextNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatDateTime(value) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatContextBudgetValue(key, value) {
  const number = finiteContextNumber(value);
  if (key === "costUsd") return `$${number.toFixed(4)}`;
  if (key === "latencyMs") return `${formatNumber(number)} ms`;
  return formatNumber(number);
}

function contextScopeLabel(scopeValue) {
  const scope = objectValue(scopeValue);
  const parts = [
    ["domain", scope.domain],
    ["project", scope.project],
    ["repository", scope.repository],
    ["path", scope.path],
    ["harness", scope.harness],
    ["model", scope.model],
    ["tool", scope.tool],
  ]
    .filter(([, value]) => typeof value === "string" && value)
    .map(([label, value]) => `${label}: ${value}`);
  return parts.length ? parts.join(" · ") : "Explicit global scope";
}

function contextInsightAuthorityKind(insight) {
  const records = Array.isArray(insight.authority) ? insight.authority : [];
  const kinds = records
    .map((record) => (typeof record === "string" ? record : objectValue(record).kind))
    .filter((kind) => typeof kind === "string");
  const ranking = [
    "authoritative-document",
    "measured-evaluation",
    "human-review",
    "human-assertion",
    "deterministic-derivation",
    "source-observation",
    "model-proposal",
    "assumption",
  ];
  return ranking.find((kind) => kinds.includes(kind)) || kinds[0] || "authority unavailable";
}

function contextAuthorityTone(value) {
  if (["human", "human-review", "human-assertion", "gate-observed"].includes(value)) return "human";
  if (
    ["provider", "provider-observed", "measured-evaluation", "authoritative-document"].includes(
      value,
    )
  )
    return "observed";
  if (["agent", "agent-self-report", "model-proposal", "heuristic"].includes(value))
    return "asserted";
  return "system";
}

function contextEventAuthority(event) {
  const payload = objectValue(event.payload);
  const evidenceGrade = event.evidenceGrade || payload.evidenceGrade;
  if (event.kind === "context.outcome.observed") {
    const byGrade = {
      "gate-observed": {
        label: "Gate-observed outcome",
        detail: "Backed by gate evidence, not an agent success statement.",
      },
      "provider-observed": {
        label: "Provider-observed outcome",
        detail: "Reported at the provider boundary; separate from an agent assertion.",
      },
      "human-asserted": {
        label: "Human-asserted outcome",
        detail: "Recorded with human authority.",
      },
      heuristic: {
        label: "Heuristic observation",
        detail: "A bounded inference, not direct provider or gate evidence.",
      },
      "agent-self-report": {
        label: "Agent assertion",
        detail: "The agent reported this outcome; it is not independent observation.",
      },
    };
    const presentation = byGrade[evidenceGrade] || {
      label: "Evidence grade unavailable",
      detail: "No outcome authority grade is available.",
    };
    return {
      ...presentation,
      tone: contextAuthorityTone(evidenceGrade || "unknown"),
    };
  }
  const authority = event.actorAuthority || payload.actorAuthority || "unknown";
  const byAuthority = {
    human: ["Human authority", "Recorded by a human operator."],
    provider: ["Provider observation", "Reported by the provider boundary."],
    agent: [
      "Agent assertion",
      "An agent assertion is weak evidence and cannot change active state.",
    ],
    tool: ["Tool observation", "Recorded by a bounded tool boundary."],
    system: ["Chatlog system record", "Recorded by the governed context plane."],
    unknown: ["Authority unavailable", "Actor authority was not available in this projection."],
  };
  const [label, detail] = byAuthority[authority] || byAuthority.unknown;
  return { label, detail, tone: contextAuthorityTone(authority) };
}

function contextReleaseHtml(release, insightByRevision) {
  if (!release) {
    return `<div class="panel-heading">
        <div><p class="eyebrow">Human authority boundary</p><h2 id="context-release-heading">Release authorization</h2></div>
        <span class="context-authority authority-asserted">Not authorized</span>
      </div>
      <div class="context-release-state">
        <strong>No operator-authorized release gate is installed.</strong>
        <p>Context delivery remains unavailable until a reviewed closed-loop gate authorizes an exposure stage.</p>
      </div>`;
  }
  const stage = typeof release.stage === "string" ? release.stage : "unknown";
  const candidate = insightByRevision.get(release.candidateId);
  return `<div class="panel-heading">
      <div><p class="eyebrow">Human authority boundary</p><h2 id="context-release-heading">Release authorization</h2></div>
      <span class="context-authority authority-human">Operator-authorized</span>
    </div>
    <div class="context-release-state authorized">
      <div>
        <span class="context-release-stage">${escapeHtml(readableCategory(stage))}</span>
        <strong>${escapeHtml(candidate?.proposition || release.candidateId || "Candidate unavailable")}</strong>
        ${candidate ? `<code class="context-release-candidate" title="${escapeHtml(release.candidateId)}">${escapeHtml(release.candidateId)}</code>` : ""}
        <p>This gate authorizes only the named candidate and exposure stage. It does not authorize broader delivery.</p>
      </div>
      <dl class="context-release-facts">
        <div><dt>Evaluation</dt><dd>${escapeHtml(release.evaluationId || "Unavailable")}</dd></div>
        <div><dt>Authorized</dt><dd><time datetime="${escapeHtml(release.authorizedAt || "")}">${escapeHtml(formatDateTime(release.authorizedAt))}</time></dd></div>
        <div><dt>Gate hash</dt><dd><code title="${escapeHtml(release.gateHash || "")}">${escapeHtml(shortHash(release.gateHash))}</code></dd></div>
      </dl>
    </div>`;
}

function contextTotalsHtml(totalsValue) {
  const totals = objectValue(totalsValue);
  const stats = [
    ["Sessions", totals.sessions, "Persisted context-session records", "⌁"],
    [
      "Delivered",
      totals.delivered,
      "Recall and procedure returns + bundle emissions; never inferred use",
      "⇥",
    ],
    ["Feedback", totals.feedback, "Human-authority feedback records", "◇"],
    ["Outcomes", totals.outcomes, "Associated observations, not causal claims", "◉"],
  ];
  return stats
    .map(
      ([label, value, foot, icon]) => `<article class="stat-card">
        <div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon}</span></div>
        <div class="stat-value">${formatNumber(value)}</div>
        <div class="stat-foot">${escapeHtml(foot)}</div>
      </article>`,
    )
    .join("");
}

function contextEvidenceIdentifiers(values, label) {
  const identifiers = stringValues(values);
  if (!identifiers.length) return "";
  return `<details class="context-identifiers">
    <summary>${escapeHtml(label)} · ${formatNumber(identifiers.length)}</summary>
    <div>${identifiers
      .map(
        (identifier) => `<code title="${escapeHtml(identifier)}">${escapeHtml(identifier)}</code>`,
      )
      .join("")}</div>
  </details>`;
}

function contextInsightsHtml(insights) {
  if (!insights.length)
    return `<div class="empty spacious">No active governed insights are eligible. Candidate, disputed, expired, and retired revisions are intentionally excluded.</div>`;
  return insights
    .map((insight) => {
      const authority = contextInsightAuthorityKind(insight);
      const support = stringValues(insight.supportEvidence);
      const counter = stringValues(insight.counterEvidence);
      const validTime = objectValue(insight.validTime);
      return `<section class="context-insight">
        <header>
          <div class="context-insight-badges">
            <span class="badge">${escapeHtml(readableCategory(insight.kind || "unknown"))}</span>
            <span class="badge risk-${escapeHtml(insight.riskClass || "unknown")}">${escapeHtml(insight.riskClass || "risk unavailable")} risk</span>
          </div>
          <span class="context-authority authority-${contextAuthorityTone(authority)}">${escapeHtml(readableCategory(authority))}</span>
        </header>
        <p class="context-proposition">${escapeHtml(insight.proposition || "Proposition unavailable")}</p>
        ${insight.procedure ? `<div class="context-procedure"><span class="context-micro-label">Procedure</span><p>${escapeHtml(insight.procedure)}</p></div>` : ""}
        <dl class="context-insight-facts">
          <div><dt>Selection basis</dt><dd>Active governed revision · advisory only</dd></div>
          <div><dt>Scope</dt><dd>${escapeHtml(contextScopeLabel(insight.scope))}</dd></div>
          <div><dt>Valid time</dt><dd>${escapeHtml(formatDate(validTime.start))} → ${validTime.end ? escapeHtml(formatDate(validTime.end)) : "open"}</dd></div>
          <div><dt>Evidence</dt><dd>${formatNumber(support.length)} support · ${formatNumber(counter.length)} counter</dd></div>
        </dl>
        <div class="context-insight-identity">
          <code title="${escapeHtml(insight.insightId || "")}">${escapeHtml(insight.insightId || "Insight ID unavailable")}</code>
          <code title="${escapeHtml(insight.revisionId || "")}">${escapeHtml(insight.revisionId || "Revision ID unavailable")}</code>
        </div>
        ${contextEvidenceIdentifiers(support, "Support evidence")}
        ${contextEvidenceIdentifiers(counter, "Counterevidence")}
      </section>`;
    })
    .join("");
}

function selectedItemIds(event, events) {
  const payload = objectValue(event.payload);
  const values = new Set(stringValues(payload.itemIds));
  if (typeof event.itemId === "string" && event.itemId) values.add(event.itemId);
  if (event.bundleHash) {
    for (const candidate of events) {
      if (candidate.bundleHash !== event.bundleHash) continue;
      for (const itemId of stringValues(objectValue(candidate.payload).itemIds)) values.add(itemId);
    }
  }
  return [...values];
}

function bundleReference(event, events) {
  if (!event.bundleHash) return event;
  return (
    events.find(
      (candidate) =>
        candidate.bundleHash === event.bundleHash &&
        stringValues(objectValue(candidate.payload).itemIds).length,
    ) ||
    events.find(
      (candidate) =>
        candidate.bundleHash === event.bundleHash &&
        Object.keys(objectValue(objectValue(candidate.payload).bounds)).length,
    ) ||
    event
  );
}

function selectedContextHtml(itemIds, insightByRevision) {
  if (!itemIds.length)
    return `<div class="context-selection-empty">No selected item identifiers are available in this bounded event.</div>`;
  return `<div class="context-selection">
    <span class="context-micro-label">Why this context was selected</span>
    ${itemIds
      .map((itemId) => {
        const insight = insightByRevision.get(itemId);
        if (!insight)
          return `<div class="context-selected-item">
            <strong>Bounded item ${escapeHtml(shortHash(itemId))}</strong>
            <span>Selected by the governed planner. Its descriptive record is unavailable in the active insight projection.</span>
            <code title="${escapeHtml(itemId)}">${escapeHtml(itemId)}</code>
          </div>`;
        const authority = contextInsightAuthorityKind(insight);
        return `<div class="context-selected-item">
          <strong>${escapeHtml(insight.proposition || insight.kind || "Governed insight")}</strong>
          <span>Active ${escapeHtml(readableCategory(insight.kind || "insight"))} matched the requested task and scope · ${escapeHtml(readableCategory(authority))} · ${escapeHtml(contextScopeLabel(insight.scope))}</span>
          <code title="${escapeHtml(itemId)}">${escapeHtml(itemId)}</code>
        </div>`;
      })
      .join("")}
  </div>`;
}

function contextBudgetFacts(reference) {
  const payload = objectValue(reference.payload);
  const bounds = objectValue(payload.bounds);
  if (!Object.keys(bounds).length) return "";
  const parts = [];
  if ("beforeTokens" in bounds || "afterTokens" in bounds)
    parts.push(`tokens ${formatNumber(bounds.beforeTokens)} → ${formatNumber(bounds.afterTokens)}`);
  if ("beforeResults" in bounds || "afterResults" in bounds)
    parts.push(
      `results ${formatNumber(bounds.beforeResults)} → ${formatNumber(bounds.afterResults)}`,
    );
  if ("beforeLatencyMs" in bounds || "afterLatencyMs" in bounds)
    parts.push(
      `latency ${formatNumber(bounds.beforeLatencyMs)} → ${formatNumber(bounds.afterLatencyMs)} ms`,
    );
  if ("beforeCostUsd" in bounds || "afterCostUsd" in bounds)
    parts.push(
      `cost $${finiteContextNumber(bounds.beforeCostUsd).toFixed(4)} → $${finiteContextNumber(bounds.afterCostUsd).toFixed(4)}`,
    );
  return parts.length
    ? `<div class="context-event-facts"><span class="context-micro-label">Planned budget</span><p>${escapeHtml(parts.join(" · "))}</p></div>`
    : "";
}

function contextSessionBudgetHtml(session) {
  const budget = objectValue(session.budget);
  const total = objectValue(budget.total);
  const remaining = objectValue(budget.remaining);
  if (!Object.keys(total).length || !Object.keys(remaining).length)
    return `<div class="empty">Remaining budget is unavailable for this session.</div>`;
  const rows = [
    ["tokens", "Tokens"],
    ["results", "Results"],
    ["latencyMs", "Latency"],
    ["costUsd", "Cost"],
  ];
  return `<div class="context-budget-grid">${rows
    .map(([key, label]) => {
      const maximum = finiteContextNumber(total[key]);
      const current = Math.min(finiteContextNumber(remaining[key]), maximum);
      return `<div class="context-budget-row">
        <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatContextBudgetValue(key, current))} <small>of ${escapeHtml(formatContextBudgetValue(key, maximum))}</small></strong></div>
        <progress aria-label="${escapeHtml(`${label} remaining`)}" max="${maximum || 1}" value="${current}"></progress>
      </div>`;
    })
    .join("")}</div>`;
}

function contextMetricsHtml(metricsValue) {
  const entries = Object.entries(objectValue(metricsValue));
  if (!entries.length) return "";
  return `<div class="context-metrics">
    ${entries
      .map(
        ([key, value]) => `<div>
          <span>${escapeHtml(readableCategory(key))}</span>
          <strong>${escapeHtml(typeof value === "number" ? formatNumber(value) : String(value))}</strong>
        </div>`,
      )
      .join("")}
  </div>`;
}

function contextLineageHtml(event) {
  const interventionIds = stringValues(event.interventionEventIds);
  const knownLineage = stringValues(event.knownInterventionLineage);
  if (!interventionIds.length && !knownLineage.length) return "";
  return `<details class="context-identifiers context-lineage">
    <summary>Associated intervention lineage · ${formatNumber(interventionIds.length + knownLineage.length)}</summary>
    <div>
      ${interventionIds.map((id) => `<code title="${escapeHtml(id)}">intervention · ${escapeHtml(id)}</code>`).join("")}
      ${knownLineage.map((id) => `<code title="${escapeHtml(id)}">known lineage · ${escapeHtml(id)}</code>`).join("")}
    </div>
    <p>Association preserves lineage; it does not establish causation.</p>
  </details>`;
}

function contextOutcomeHtml(event) {
  const payload = objectValue(event.payload);
  const status = event.outcomeStatus || payload.outcomeStatus || payload.status || "unknown";
  const grade = event.evidenceGrade || payload.evidenceGrade || "unavailable";
  const treatment = event.treatmentArm || payload.treatmentArm || "unavailable";
  const classification =
    event.evidenceClassification || payload.evidenceClassification || "unavailable";
  const resolved =
    event.unresolved === true
      ? "Unresolved"
      : event.unresolved === false
        ? "Resolved"
        : "Resolution unavailable";
  return `<div class="context-outcome">
    <div class="context-outcome-summary">
      <div><span>Status</span><strong class="outcome-${escapeHtml(status)}">${escapeHtml(readableCategory(status))}</strong></div>
      <div><span>Evidence grade</span><strong>${escapeHtml(readableCategory(grade))}</strong></div>
      <div><span>Treatment</span><strong>${escapeHtml(readableCategory(treatment))}</strong></div>
      <div><span>Independence</span><strong>${escapeHtml(readableCategory(classification))}</strong></div>
      <div><span>Resolution</span><strong>${escapeHtml(resolved)}</strong></div>
    </div>
    ${contextMetricsHtml(payload.metrics)}
    <p class="context-causality">This observation is associated with intervention lineage. The ledger makes no causal claim.</p>
  </div>`;
}

function contextFeedbackRecordHtml(event) {
  const payload = objectValue(event.payload);
  const signal = payload.signal || payload.feedbackSignal || "signal unavailable";
  const strength =
    payload.feedbackAuthority === "weak"
      ? "Weak agent assertion"
      : payload.feedbackAuthority === "strong"
        ? "Human-authority feedback"
        : "Feedback authority unavailable";
  return `<div class="context-feedback-record">
    <strong>${escapeHtml(readableCategory(String(signal)))}</strong>
    <span>${escapeHtml(strength)}${event.itemId ? ` · item ${escapeHtml(event.itemId)}` : ""}</span>
    ${payload.note ? `<p>${escapeHtml(payload.note)}</p>` : ""}
  </div>`;
}

function contextFeedbackFormHtml(sessionId, eventId, itemIds) {
  const feedback = state.contextFeedback[eventId];
  const statusId = `context-feedback-status-${eventId}`;
  const itemId = itemIds.length === 1 ? itemIds[0] : "";
  return `<form class="context-feedback-form" data-context-session-id="${escapeHtml(sessionId)}" data-intervention-event-id="${escapeHtml(eventId)}">
    <fieldset>
      <legend>Record human feedback for this delivered event</legend>
      <div class="context-feedback-grid">
        <label>
          <span>Signal</span>
          <select name="signal" required>
            <option value="">Choose a signal…</option>
            ${CONTEXT_FEEDBACK_OPTIONS.map(
              ([value, label]) =>
                `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`,
            ).join("")}
          </select>
        </label>
        <label>
          <span>Operator ID</span>
          <input name="operatorId" required maxlength="80" autocomplete="off" placeholder="local-operator" />
        </label>
        <label>
          <span>Item ID <small>optional</small></span>
          <input name="itemId" maxlength="1500" autocomplete="off" value="${escapeHtml(itemId)}" placeholder="Apply to the whole delivery" />
        </label>
        <label class="context-feedback-note">
          <span>Note <small>optional · maximum 1,500 characters</small></span>
          <textarea name="note" rows="2" maxlength="1500" placeholder="What helped, harmed, or did not fit?"></textarea>
        </label>
      </div>
      <div class="context-feedback-actions">
        <button type="submit">Record feedback</button>
        <p id="${escapeHtml(statusId)}" class="context-feedback-status ${feedback?.tone === "success" ? "success" : ""}" role="${feedback?.tone === "error" ? "alert" : "status"}" aria-live="${feedback?.tone === "error" ? "assertive" : "polite"}">${feedback ? escapeHtml(feedback.message) : "Feedback affects future review only. It does not change this active session."}</p>
      </div>
    </fieldset>
  </form>`;
}

function contextOutcomeFormHtml(sessionId, eventId) {
  const outcome = state.contextOutcome[eventId];
  const statusId = `context-outcome-status-${eventId}`;
  return `<details class="context-outcome-entry"${outcome ? " open" : ""}>
    <summary>Record an observed outcome</summary>
    <form class="context-feedback-form context-outcome-form" data-context-session-id="${escapeHtml(sessionId)}" data-intervention-event-id="${escapeHtml(eventId)}">
      <fieldset>
        <legend>Associate a human-observed result with this delivered event</legend>
        <div class="context-feedback-grid">
          <label>
            <span>Result</span>
            <select name="status" required>
              <option value="">Choose a result…</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="mixed">Mixed</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label>
            <span>Context treatment</span>
            <select name="treatmentArm" required>
              <option value="">Choose the context used…</option>
              ${CONTEXT_TREATMENT_OPTIONS.map(
                ([value, label]) =>
                  `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`,
              ).join("")}
            </select>
          </label>
          <label>
            <span>Operator ID</span>
            <input name="operatorId" required maxlength="80" autocomplete="off" placeholder="local-operator" />
          </label>
          <label>
            <span>Resolution</span>
            <select name="unresolved" required>
              <option value="false">Resolved</option>
              <option value="true">Still unresolved</option>
            </select>
          </label>
          <label class="context-feedback-note">
            <span>Observation <small>optional · maximum 1,500 characters</small></span>
            <textarea name="note" rows="2" maxlength="1500" placeholder="What happened after this context was delivered?"></textarea>
          </label>
        </div>
        <div class="context-feedback-actions">
          <button type="submit">Record outcome</button>
          <p id="${escapeHtml(statusId)}" class="context-feedback-status ${outcome?.tone === "success" ? "success" : ""}" role="${outcome?.tone === "error" ? "alert" : "status"}" aria-live="${outcome?.tone === "error" ? "assertive" : "polite"}">${outcome ? escapeHtml(outcome.message) : "This records association, not causation. Human assertions remain visibly graded."}</p>
        </div>
      </fieldset>
    </form>
  </details>`;
}

function contextEventTone(event) {
  if (event.kind === "context.delivery.failed") return "negative";
  if (event.kind === "context.feedback.asserted") return "feedback";
  if (event.kind === "context.outcome.observed")
    return contextEventAuthority(event).tone === "asserted" ? "asserted" : "observed";
  if (
    [
      "context.bundle.emitted",
      "context.bundle.acknowledged",
      "context.recall.returned",
      "context.procedure.returned",
    ].includes(event.kind)
  )
    return "delivered";
  return "planned";
}

function contextEventHtml(event, session, events, insightByRevision) {
  const payload = objectValue(event.payload);
  const reference = bundleReference(event, events);
  const referencePayload = objectValue(reference.payload);
  const provenance = objectValue(referencePayload.provenance);
  const target = objectValue(session.target);
  const itemIds = selectedItemIds(event, events);
  const authority = contextEventAuthority(event);
  const delivered = [
    "context.bundle.emitted",
    "context.recall.returned",
    "context.procedure.returned",
  ].includes(event.kind);
  const hasProposal = events.some(
    (candidate) =>
      candidate.kind === "context.bundle.proposed" &&
      candidate.bundleHash &&
      candidate.bundleHash === event.bundleHash,
  );
  const showSelection = event.kind === "context.bundle.proposed" || (delivered && !hasProposal);
  const destination = delivered
    ? `<div class="context-destination">
        <span>Delivered to</span>
        <strong>${escapeHtml(target.provider || "Unknown provider")} · ${escapeHtml(target.harness || "Unknown harness")}</strong>
        <small>${escapeHtml(provenance.deliveryMode ? readableCategory(provenance.deliveryMode) : "Delivery mode unavailable")}${target.model ? ` · ${escapeHtml(target.model)}` : ""}${payload.adapterId ? ` · ${escapeHtml(payload.adapterId)}` : ""}</small>
      </div>`
    : "";
  const eventFacts = [
    referencePayload.omissionCount != null
      ? `${formatNumber(referencePayload.omissionCount)} omissions`
      : "",
    provenance.exposure ? `${readableCategory(provenance.exposure)} exposure` : "",
    payload.receiptEvidence ? `${readableCategory(payload.receiptEvidence)} receipt` : "",
  ].filter(Boolean);
  const failure =
    event.kind === "context.delivery.failed"
      ? `<p class="context-event-error">${escapeHtml(payload.message || payload.error || payload.reason || "The delivery failure reason is unavailable.")}</p>`
      : "";
  const specific =
    event.kind === "context.outcome.observed"
      ? contextOutcomeHtml(event)
      : event.kind === "context.feedback.asserted"
        ? contextFeedbackRecordHtml(event)
        : "";
  return `<article class="context-event context-event-${contextEventTone(event)}">
    <div class="context-event-marker" aria-hidden="true"></div>
    <div class="context-event-body">
      <header>
        <div>
          <span class="context-event-state">${escapeHtml(CONTEXT_EVENT_LABELS[event.kind] || readableCategory(event.state || event.kind || "Unknown event"))}</span>
          <time datetime="${escapeHtml(event.occurredAt || event.observedAt || "")}">${escapeHtml(formatDateTime(event.occurredAt || event.observedAt))}</time>
        </div>
        <span class="context-authority authority-${authority.tone}" title="${escapeHtml(authority.detail)}">${escapeHtml(authority.label)}</span>
      </header>
      <p class="context-authority-detail">${escapeHtml(authority.detail)}</p>
      ${eventFacts.length ? `<p class="context-event-summary">${escapeHtml(eventFacts.join(" · "))}</p>` : ""}
      ${destination}
      ${showSelection ? selectedContextHtml(itemIds, insightByRevision) : ""}
      ${showSelection ? contextBudgetFacts(reference) : ""}
      ${failure}
      ${specific}
      ${contextLineageHtml(event)}
      <div class="context-event-identity">
        <code title="${escapeHtml(event.eventId || "")}">event · ${escapeHtml(event.eventId || "unavailable")}</code>
        ${event.bundleHash ? `<code title="${escapeHtml(event.bundleHash)}">bundle · ${escapeHtml(event.bundleHash)}</code>` : ""}
      </div>
      ${delivered ? contextFeedbackFormHtml(session.contextSessionId, event.eventId, itemIds) : ""}
      ${delivered ? contextOutcomeFormHtml(session.contextSessionId, event.eventId) : ""}
    </div>
  </article>`;
}

function contextSessionHtml(entry, index, insightByRevision) {
  const session = objectValue(entry.session);
  const events = Array.isArray(entry.events) ? entry.events : [];
  const target = objectValue(session.target);
  const domainPolicy = stringValues(session.domainPolicy);
  const headingId = `context-session-heading-${index}`;
  return `<section class="context-session" aria-labelledby="${headingId}">
    <header class="context-session-head">
      <div class="context-target-mark" aria-hidden="true">${escapeHtml(
        String(target.provider || "?")
          .slice(0, 1)
          .toUpperCase(),
      )}</div>
      <div>
        <span class="context-micro-label">Provider / harness target</span>
        <h3 id="${headingId}">${escapeHtml(target.provider || "Unknown provider")} <span>via ${escapeHtml(target.harness || "unknown harness")}</span></h3>
        <p>${target.model ? `${escapeHtml(target.model)} · ` : ""}${escapeHtml(target.role || "role unavailable")} · ${escapeHtml(session.projectIdentity || "project unavailable")}</p>
      </div>
      <span class="badge">${formatNumber(events.length)} bounded events</span>
    </header>
    <dl class="context-session-facts">
      <div><dt>Context session</dt><dd><code>${escapeHtml(session.contextSessionId || "Unavailable")}</code></dd></div>
      <div><dt>Provider session</dt><dd>${escapeHtml(session.nativeSessionId || "Not reported")}</dd></div>
      <div><dt>Domain policy</dt><dd>${domainPolicy.length ? escapeHtml(domainPolicy.join(", ")) : "Unavailable"}</dd></div>
      <div><dt>Updated</dt><dd>${escapeHtml(formatDateTime(session.updatedAt || session.createdAt))}</dd></div>
    </dl>
    <section class="context-budget" aria-label="Remaining context budget">
      <div class="context-subheading">
        <div><span class="context-micro-label">Hard bounds</span><h4>Remaining budget</h4></div>
        <span>after delivered bundles</span>
      </div>
      ${contextSessionBudgetHtml(session)}
    </section>
    <details class="context-session-provenance">
      <summary>Inspect pinned policy and projection identifiers</summary>
      <dl>
        <div><dt>Selection policy</dt><dd><code>${escapeHtml(session.selectionPolicyVersion || "Unavailable")}</code></dd></div>
        <div><dt>Delivery policy</dt><dd><code>${escapeHtml(session.deliveryPolicyVersion || "Unavailable")}</code></dd></div>
        <div><dt>Insight projection</dt><dd><code>${escapeHtml(session.pinnedInsightProjectionHash || "Unavailable")}</code></dd></div>
        <div><dt>Evidence projection</dt><dd><code>${escapeHtml(session.pinnedEvidenceProjectionHash || "Unavailable")}</code></dd></div>
      </dl>
    </details>
    <div class="context-event-ledger">
      <div class="context-subheading">
        <div><span class="context-micro-label">Chain of custody</span><h4>Interventions and observations</h4></div>
        <span>ordered ledger</span>
      </div>
      ${events.length ? events.map((event) => contextEventHtml(event, session, events, insightByRevision)).join("") : `<div class="empty">No context events are recorded for this session.</div>`}
    </div>
  </section>`;
}

function renderContextLoading() {
  $("#context-view-status").setAttribute("role", "status");
  $("#context-view-status").textContent = "Loading governed context…";
  $("#context-release").innerHTML =
    `<div class="panel-heading"><div><p class="eyebrow">Human authority boundary</p><h2 id="context-release-heading">Release authorization</h2></div></div><div class="empty">Loading release authorization…</div>`;
  $("#context-totals").innerHTML =
    `<div class="empty spacious">Loading context activity totals…</div>`;
  $("#context-insights").innerHTML = `<div class="empty">Loading active governed insights…</div>`;
  $("#context-sessions").innerHTML =
    `<div class="empty">Loading provider and harness sessions…</div>`;
  $("#context-insights").setAttribute("aria-busy", "true");
  $("#context-sessions").setAttribute("aria-busy", "true");
}

function renderContextError(message) {
  const copy = `Context plane unavailable: ${message}`;
  $("#context-view-status").setAttribute("role", "alert");
  $("#context-view-status").textContent = "Context plane unavailable";
  $("#context-release").innerHTML =
    `<div class="panel-heading"><div><p class="eyebrow">Human authority boundary</p><h2 id="context-release-heading">Release authorization</h2></div></div><div class="empty context-error">${escapeHtml(copy)}</div>`;
  $("#context-totals").innerHTML =
    `<div class="empty spacious context-error">${escapeHtml(copy)} No activity counts are shown as authoritative.</div>`;
  $("#context-insights").innerHTML =
    `<div class="empty context-error">${escapeHtml(copy)} Active eligibility is unknown.</div>`;
  $("#context-sessions").innerHTML =
    `<div class="empty context-error">${escapeHtml(copy)} Delivery and outcome records could not be inspected.</div>`;
  $("#context-insights").setAttribute("aria-busy", "false");
  $("#context-sessions").setAttribute("aria-busy", "false");
}

function renderContext() {
  if (state.contextLoading && !state.context) {
    renderContextLoading();
    return;
  }
  if (state.contextError) {
    renderContextError(state.contextError);
    return;
  }
  const view = state.context;
  if (
    !view ||
    !Array.isArray(view.insights) ||
    !Array.isArray(view.sessions) ||
    !view.totals ||
    typeof view.totals !== "object"
  ) {
    renderContextError("The server response did not match the governed context contract.");
    return;
  }
  const insightByRevision = new Map(
    view.insights
      .filter((insight) => typeof insight.revisionId === "string")
      .map((insight) => [insight.revisionId, insight]),
  );
  $("#context-view-status").setAttribute("role", "status");
  $("#context-view-status").textContent = state.contextLoading
    ? "Refreshing governed context…"
    : `${formatNumber(view.sessions.length)} context sessions loaded`;
  $("#context-release").innerHTML = contextReleaseHtml(view.release, insightByRevision);
  $("#context-totals").innerHTML = contextTotalsHtml(view.totals);
  $("#context-insights").innerHTML = contextInsightsHtml(view.insights);
  $("#context-sessions").innerHTML =
    view.sessions
      .map((entry, index) => contextSessionHtml(entry, index, insightByRevision))
      .join("") ||
    `<div class="empty spacious">No context sessions have been persisted. Delivery, budget, feedback, and outcome records will appear after a governed session starts.</div>`;
  $("#context-insights").setAttribute("aria-busy", "false");
  $("#context-sessions").setAttribute("aria-busy", "false");
}

async function loadContext() {
  state.contextLoading = true;
  state.contextError = null;
  renderContext();
  try {
    state.context = await api("/api/context");
  } catch (error) {
    state.context = null;
    state.contextError = error.message;
  } finally {
    state.contextLoading = false;
    renderContext();
  }
}

async function submitContextFeedback(form) {
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  const contextSessionId = form.dataset.contextSessionId;
  const interventionEventId = form.dataset.interventionEventId;
  const signal = String(formData.get("signal") || "");
  const operatorId = String(formData.get("operatorId") || "").trim();
  const itemId = String(formData.get("itemId") || "").trim();
  const note = String(formData.get("note") || "").trim();
  const body = {
    contextSessionId,
    interventionEventId,
    signal,
    operatorId,
    ...(itemId ? { itemId } : {}),
    ...(note ? { note } : {}),
  };
  const controls = $$("input, select, textarea, button", form);
  const status = $(".context-feedback-status", form);
  const submit = $('button[type="submit"]', form);
  form.setAttribute("aria-busy", "true");
  controls.forEach((control) => {
    control.disabled = true;
  });
  submit.textContent = "Recording…";
  status.className = "context-feedback-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Recording human-authority feedback…";
  try {
    const refreshed = await api("/api/context/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chatlog-Context": "1",
      },
      body: JSON.stringify(body),
    });
    const label = CONTEXT_FEEDBACK_OPTIONS.find(([value]) => value === signal)?.[1] || signal;
    state.context = refreshed;
    state.contextError = null;
    state.contextFeedback[interventionEventId] = {
      tone: "success",
      message: `${label} feedback recorded with human authority.`,
    };
    renderContext();
  } catch (error) {
    form.setAttribute("aria-busy", "false");
    controls.forEach((control) => {
      control.disabled = false;
    });
    submit.textContent = "Record feedback";
    status.className = "context-feedback-status error";
    status.setAttribute("role", "alert");
    status.setAttribute("aria-live", "assertive");
    status.textContent = `Feedback was not recorded: ${error.message}`;
  }
}

async function submitContextOutcome(form) {
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  const contextSessionId = form.dataset.contextSessionId;
  const interventionEventId = form.dataset.interventionEventId;
  const statusValue = String(formData.get("status") || "");
  const treatmentArm = String(formData.get("treatmentArm") || "");
  const operatorId = String(formData.get("operatorId") || "").trim();
  const unresolved = String(formData.get("unresolved")) === "true";
  const note = String(formData.get("note") || "").trim();
  const controls = $$("input, select, textarea, button", form);
  const status = $(".context-feedback-status", form);
  const submit = $('button[type="submit"]', form);
  form.setAttribute("aria-busy", "true");
  controls.forEach((control) => {
    control.disabled = true;
  });
  submit.textContent = "Recording…";
  status.className = "context-feedback-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Recording a human-observed outcome…";
  try {
    const refreshed = await api("/api/context/outcome", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chatlog-Context": "1",
      },
      body: JSON.stringify({
        contextSessionId,
        interventionEventId,
        status: statusValue,
        treatmentArm,
        unresolved,
        operatorId,
        ...(note ? { note } : {}),
      }),
    });
    state.context = refreshed;
    state.contextError = null;
    state.contextOutcome[interventionEventId] = {
      tone: "success",
      message: `${readableCategory(statusValue)} outcome recorded as a human assertion.`,
    };
    renderContext();
  } catch (error) {
    form.setAttribute("aria-busy", "false");
    controls.forEach((control) => {
      control.disabled = false;
    });
    submit.textContent = "Record outcome";
    status.className = "context-feedback-status error";
    status.setAttribute("role", "alert");
    status.setAttribute("aria-live", "assertive");
    status.textContent = `Outcome was not recorded: ${error.message}`;
  }
}

async function load() {
  $("#day-part").textContent =
    new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening";
  const contextRequest = loadContext();
  try {
    const [overview, projects, sources] = await Promise.allSettled([
      api("/api/overview"),
      api("/api/projects?limit=200"),
      api("/api/sources"),
    ]);
    if (overview.status === "rejected") throw overview.reason;
    state.overview = overview.value;
    state.projects = projects.status === "fulfilled" ? projects.value : [];
    state.sources = sources.status === "fulfilled" ? sources.value : [];
    try {
      state.insights = await api("/api/insights?candidateLimit=0");
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
    try {
      state.sourceReceipts = await api("/api/source-receipts?limit=100");
      state.sourceReceiptError = null;
    } catch (error) {
      state.sourceReceipts = [];
      state.sourceReceiptError = error.message;
    }
    try {
      state.nominations = await api("/api/nominations");
      state.nominationError = null;
    } catch (error) {
      state.nominations = [];
      state.nominationError = error.message;
    }
    state.candidatePage = 1;
    try {
      state.candidateResult = await api(
        `/api/knowledge-candidates?type=${encodeURIComponent(state.candidateFilter)}&page=1&pageSize=${state.candidatePageSize}`,
      );
      state.candidateError = null;
    } catch (error) {
      state.candidateResult = null;
      state.candidateError = error.message;
    }
    renderOverview();
    renderProjects();
    renderInsights();
    renderSources();
  } catch (error) {
    $("#sync-copy").textContent = "Workbench error";
    $("#overview-subtitle").textContent = error.message;
  }
  await contextRequest;
}

$$(".nav-item[data-view]").forEach((button) =>
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
$("#context-sessions").addEventListener("submit", (event) => {
  const outcomeForm = event.target.closest(".context-outcome-form");
  if (outcomeForm) {
    event.preventDefault();
    submitContextOutcome(outcomeForm);
    return;
  }
  const feedbackForm = event.target.closest(".context-feedback-form");
  if (!feedbackForm) return;
  event.preventDefault();
  submitContextFeedback(feedbackForm);
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
void bootstrapWorkbench().then(load);
