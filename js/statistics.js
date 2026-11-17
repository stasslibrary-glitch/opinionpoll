import { auth, db, showConfigWarning } from "./firebase.js";
import { collection, getDocs, getDoc, doc, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const container = document.getElementById("stats-container");
const kpisEl = document.getElementById("stats-kpis");
const leaderboardEl = document.getElementById("leaderboard");
const insightsEl = document.getElementById("insights-list");
const participationEl = document.getElementById("participation-panel");
const statusLegendEl = document.getElementById("status-legend");
const overallCanvas = document.getElementById("overall-canvas");
const statusCanvas = document.getElementById("status-canvas");
const logoutBtn = document.getElementById("logout-btn");
const graphBtn = document.getElementById("view-graph");
const chartBtn = document.getElementById("view-chart");
const refreshBtn = document.getElementById("refresh-stats");
const modeLabel = document.getElementById("mode-label");
const msgEl = document.getElementById("stats-message");

let postDataCache = [];
let viewMode = "graph"; // graph = bars, chart = pie/donut

const COLORS = [
  "#2563eb", "#ff2d55", "#ffd60a", "#16a34a", "#7c3aed",
  "#06b6d4", "#f97316", "#ec4899", "#84cc16", "#0ea5e9",
  "#eab308", "#14b8a6"
];

function setMsg(text, type = "info") {
  if (!msgEl) return;
  if (!text) { msgEl.classList.add("hidden"); msgEl.textContent = ""; return; }
  msgEl.className = `message ${type}`;
  msgEl.textContent = text;
  msgEl.classList.remove("hidden");
}

async function isAdmin(uid) {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists();
}

async function requireAdmin() {
  if (showConfigWarning(document) || !auth || !db) return false;
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) { window.location.href = "admin-login.html"; resolve(false); return; }
      try {
        const ok = await isAdmin(user.uid);
        if (!ok) { await signOut(auth); window.location.href = "admin-login.html"; resolve(false); return; }
        resolve(true);
      } catch (err) {
        console.error(err);
        await signOut(auth);
        window.location.href = "admin-login.html";
        resolve(false);
      }
    });
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "admin-login.html";
  });
}

function setViewMode(mode) {
  viewMode = mode;
  if (graphBtn) { graphBtn.classList.toggle("active", mode === "graph"); graphBtn.classList.toggle("secondary", mode !== "graph"); }
  if (chartBtn) { chartBtn.classList.toggle("active", mode === "chart"); chartBtn.classList.toggle("secondary", mode !== "chart"); }
  if (modeLabel) modeLabel.textContent = mode === "graph" ? "bar graph" : "pie chart";
  renderAll();
}

if (graphBtn) graphBtn.addEventListener("click", () => setViewMode("graph"));
if (chartBtn) chartBtn.addEventListener("click", () => setViewMode("chart"));
if (refreshBtn) refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true; refreshBtn.textContent = "Refreshing...";
  await loadStats();
  refreshBtn.disabled = false; refreshBtn.textContent = "Refresh Data";
});

if (document.getElementById("export-results")) {
  document.getElementById("export-results").addEventListener("click", () => {
    openResultsReport();
  });
}

if (document.getElementById("download-pdf")) {
  document.getElementById("download-pdf").addEventListener("click", () => {
    const pdfSection = document.getElementById("pdf-print-section");
    if (!pdfSection) { setMsg("PDF section not found.", "error"); return; }

    const m = metrics();
    document.getElementById("pdf-date").textContent = new Date().toLocaleString();

    // Summary grid
    const summaryGrid = document.getElementById("pdf-summary-grid");
    summaryGrid.innerHTML = `
      <div class="pdf-sum-card"><div class="pdf-sum-val">${m.totalPosts}</div><div class="pdf-sum-lab">Total Posts</div></div>
      <div class="pdf-sum-card"><div class="pdf-sum-val">${m.totalVotes}</div><div class="pdf-sum-lab">Total Votes</div></div>
      <div class="pdf-sum-card"><div class="pdf-sum-val">${m.totalCandidates}</div><div class="pdf-sum-lab">Candidates</div></div>
      <div class="pdf-sum-card"><div class="pdf-sum-val">${fmt(m.participation, 0)}%</div><div class="pdf-sum-lab">Participation</div></div>
      <div class="pdf-sum-card"><div class="pdf-sum-val">${m.open}</div><div class="pdf-sum-lab">Open Posts</div></div>
      <div class="pdf-sum-card"><div class="pdf-sum-val">${m.closed}</div><div class="pdf-sum-lab">Closed Posts</div></div>
    `;

    // Winners grid (top candidate per post)
    const winnersGrid = document.getElementById("pdf-winners-grid");
    const postWinners = postDataCache.filter(p => p.total > 0 && p.candidates.length > 0);
    winnersGrid.innerHTML = postWinners.map(p => {
      const winner = p.candidates[0];
      const isOverallTop = m.allCands.length > 0 && m.allCands[0].id === winner.id && m.allCands[0].postId === p.post.id;
      return `
        <div class="pdf-winner-card ${isOverallTop ? 'pdf-winner-overall' : ''}">
          <div class="pdf-winner-rank">${isOverallTop ? '👑 OVERALL WINNER' : '🥇 Winner'}</div>
          <div class="pdf-winner-post">${escapeHtml(p.post.title || "Untitled")}</div>
          <div class="pdf-winner-name">${escapeHtml(winner.name || "Unnamed")}</div>
          <div class="pdf-winner-votes">${Number(winner.votes) || 0} votes</div>
          <div class="pdf-winner-share">${p.total > 0 ? Math.round(((Number(winner.votes) || 0) / p.total) * 100) : 0}% of post votes</div>
        </div>
      `;
    }).join("") || `<div class="pdf-empty">No winners yet (no votes cast).</div>`;

    // Detailed results list
    const resultsList = document.getElementById("pdf-results-list");
    resultsList.innerHTML = postDataCache.map(p => {
      const rows = p.candidates.map((c, i) => {
        const v = Number(c.votes) || 0;
        const pct = p.total > 0 ? Math.round((v / p.total) * 100) : 0;
        const isWinner = i === 0 && p.total > 0;
        return `
          <div class="pdf-cand-row ${isWinner ? 'pdf-cand-winner' : ''}">
            <span class="pdf-cand-num">${i + 1}</span>
            <span class="pdf-cand-name">${escapeHtml(c.name || "Unnamed")}</span>
            <span class="pdf-cand-votes">${v}</span>
            <span class="pdf-cand-pct">${pct}%</span>
          </div>
        `;
      }).join("");
      return `
        <div class="pdf-post-block">
          <div class="pdf-post-header">
            <span class="pdf-post-title">${escapeHtml(p.post.title || "Untitled")}</span>
            <span class="pdf-post-badge ${p.post.status === "closed" ? "closed" : "open"}">${p.post.status === "closed" ? "CLOSED" : "OPEN"}</span>
          </div>
          <div class="pdf-post-total"><strong>${p.total}</strong> total vote(s) &middot; ${p.candidates.length} candidate(s)</div>
          <div class="pdf-cand-table">
            <div class="pdf-cand-head">
              <span>#</span><span>Candidate</span><span style="text-align:right">Votes</span><span style="text-align:right">%</span>
            </div>
            ${rows}
          </div>
        </div>
      `;
    }).join("");

    pdfSection.classList.remove("hidden");
    setTimeout(() => window.print(), 400);
    setTimeout(() => pdfSection.classList.add("hidden"), 2000);
  });
}

function openResultsReport() {
  const m = metrics();
  const modal = document.createElement("div");
  modal.className = "results-report-modal";
  modal.innerHTML = `
    <div class="report-backdrop" onclick="closeResultsReport()"></div>
    <div class="report-card">
      <div class="report-header">
        <div class="school-badge">🏫</div>
        <div class="report-title">
          <div class="report-eyebrow">St. Thomas Aquinas S.S. Kawempe</div>
          <h2>End of Year Opinion Poll</h2>
          <div class="report-motto">"The Source Of Knowledge And Wisdom"</div>
        </div>
        <button class="report-close" onclick="closeResultsReport()">✕</button>
      </div>

      <div class="report-body">
        <div class="report-summary">
          <h3>📊 Poll Summary</h3>
          <div class="summary-grid">
            <div class="summary-card"><span class="big">${m.totalPosts}</span><span class="label">Total Posts</span></div>
            <div class="summary-card"><span class="big">${m.totalVotes}</span><span class="label">Total Votes</span></div>
            <div class="summary-card"><span class="big">${m.totalCandidates}</span><span class="label">Candidates</span></div>
            <div class="summary-card"><span class="big">${fmt(m.participation, 0)}%</span><span class="label">Participation</span></div>
            <div class="summary-card"><span class="big">${m.open}</span><span class="label">Open Posts</span></div>
            <div class="summary-card"><span class="big">${m.closed}</span><span class="label">Closed Posts</span></div>
          </div>
        </div>

        <div class="report-section">
          <h3>🏆 Leaderboard</h3>
          <div class="leaderboard-list">
            ${m.allCands.slice(0, 10).map((c, i) => `
              <div class="leader-item">
                <span class="rank-badge">${i + 1}</span>
                <span class="cand-name">${escapeHtml(c.name || "Unnamed")}</span>
                <span class="cand-post">${escapeHtml(c.postTitle || "Untitled")}</span>
                <span class="cand-votes">${Number(c.votes) || 0} votes</span>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="report-section">
          <h3>📈 Post Results</h3>
          <div class="post-list">
            ${postDataCache.map(p => `
              <div class="post-item">
                <div class="post-info">
                  <span class="post-title">${escapeHtml(p.post.title || "Untitled")}</span>
                  <span class="post-badge ${p.post.status === "closed" ? "closed" : "open"}">${p.post.status === "closed" ? "Closed" : "Open"}</span>
                </div>
                <div class="post-total">${p.total} vote(s)</div>
                <div class="cand-mini-list">
                  ${p.candidates.map((c, i) => {
                    const pct = p.total > 0 ? Math.round(((Number(c.votes) || 0) / p.total) * 100) : 0;
                    const color = COLORS[i % COLORS.length];
                    return `<div class="cand-mini">
                      <span class="cand-dot" style="background:${color}"></span>
                      <span class="cand-mini-name">${escapeHtml(c.name || "Unnamed")}</span>
                      <span class="cand-mini-votes">${Number(c.votes) || 0}</span>
                    </div>`;
                  }).join("")}
                </div>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="report-insights">
          <h3>✨ Highlights</h3>
          <div class="insight-chips">
            ${m.most ? `<span class="chip">🔥 Top: ${escapeHtml(m.most.post.title)} (${m.most.total} votes)</span>` : ""}
            ${m.least ? `<span class="chip">📉 Lowest: ${escapeHtml(m.least.post.title)} (${m.least.total} votes)</span>` : ""}
            ${m.allCands.length > 0 ? `<span class="chip">🏆 Winner: ${escapeHtml(m.allCands[0].name)}</span>` : ""}
            <span class="chip">📊 ${fmt(m.participation, 0)}% participation</span>
          </div>
        </div>
      </div>

      <div class="report-footer">
        <div class="report-generated">Generated on ${new Date().toLocaleDateString()} 
        <br> at ${new Date().toLocaleTimeString()}</div>
        <button class="btn print-btn" onclick="window.print()">🖨️ Print Report</button>
        <button class="btn close-btn" onclick="closeResultsReport()">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add("show"), 10);
}

window.closeResultsReport = function() {
  const modal = document.querySelector(".results-report-modal");
  if (modal) {
    modal.classList.remove("show");
    setTimeout(() => modal.remove(), 300);
  }
};

async function loadStats() {
  if (!container) return;
  setMsg("", "info");
  try {
    const postsSnap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "asc")));
    if (postsSnap.empty) { postDataCache = []; renderAll(); return; }
    postDataCache = await Promise.all(postsSnap.docs.map(async (postDoc) => {
      const post = { id: postDoc.id, ...postDoc.data() };
      try {
        const candidatesSnap = await getDocs(query(collection(db, "candidates"), where("postId", "==", post.id)));
        const candidates = candidatesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        candidates.sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0));
        const total = candidates.reduce((s, c) => s + (Number(c.votes) || 0), 0);
        return { post, candidates, total, error: null };
      } catch (err) {
        console.error(err);
        return { post, candidates: [], total: 0, error: err };
      }
    }));
    renderAll();
  } catch (err) {
    console.error(err);
    setMsg(`Failed to load statistics: ${err.message}`, "error");
    if (container) container.innerHTML = `<div class="card"><p class="message error">Could not load statistics.</p></div>`;
  }
}

function fmt(n, d = 1) { return Number.isInteger(n) ? String(n) : n.toFixed(d); }

function metrics() {
  const totalPosts = postDataCache.length;
  let totalCandidates = 0, totalVotes = 0, open = 0, closed = 0, activePosts = 0;
  let most = null, least = null, ties = 0;

  postDataCache.forEach(p => {
    totalCandidates += p.candidates.length;
    totalVotes += p.total;
    if (p.post.status === "closed") closed++; else open++;
    if (p.total > 0) activePosts++;
    if (!most || p.total > most.total) most = p;
    if (!least || p.total < least.total) least = p;
    if (p.candidates.length > 1 && p.total > 0) {
      const top = Number(p.candidates[0].votes) || 0;
      const tiedTop = p.candidates.filter(c => (Number(c.votes) || 0) === top).length;
      if (tiedTop > 1) ties++;
    }
  });

  const avgVotes = totalPosts ? totalVotes / totalPosts : 0;
  const avgCands = totalPosts ? totalCandidates / totalPosts : 0;
  const participation = totalPosts ? (activePosts / totalPosts) * 100 : 0;

  const allCands = [];
  postDataCache.forEach(p => p.candidates.forEach(c => allCands.push({ ...c, postTitle: p.post.title || "Untitled", postId: p.post.id })));
  allCands.sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0));

  return { totalPosts, totalCandidates, totalVotes, open, closed, activePosts, avgVotes, avgCands, participation, most, least, ties, allCands };
}

function renderAll() {
  if (!container || !kpisEl) return;
  if (postDataCache.length === 0) {
    kpisEl.innerHTML = "";
    if (leaderboardEl) leaderboardEl.innerHTML = `<p class="empty-msg">No data yet.</p>`;
    if (insightsEl) insightsEl.innerHTML = `<p class="empty-msg">No insights yet.</p>`;
    if (participationEl) participationEl.innerHTML = `<p class="empty-msg">No data yet.</p>`;
    if (statusLegendEl) statusLegendEl.innerHTML = "";
    if (overallCanvas) clearCanvas(overallCanvas, "No data");
    if (statusCanvas) clearCanvas(statusCanvas, "No data");
    container.innerHTML = `<div class="card"><h3>No statistics yet</h3><p class="muted">Create posts and collect votes to see analytics.</p></div>`;
    return;
  }
  const m = metrics();
  renderKPIs(m);
  renderOverallChart(m);
  renderStatus(m);
  renderParticipation(m);
  renderLeaderboard(m);
  renderInsights(m);
  renderPosts(m);
}

function renderKPIs(m) {
  const items = [
    { icon: "📋", value: m.totalPosts, label: "Total Posts", cls: "" },
    { icon: "🗳️", value: m.totalVotes, label: "Total Votes", cls: "gold" },
    { icon: "📊", value: fmt(m.avgVotes), label: "Avg Votes / Post", cls: "purple" },
    { icon: "👥", value: m.totalCandidates, label: "Candidates", cls: "" },
    { icon: "🧮", value: fmt(m.avgCands), label: "Avg Candidates / Post", cls: "" },
    { icon: "✅", value: `${fmt(m.participation, 0)}%`, label: "Participation", cls: "green" },
    { icon: "🟢", value: m.open, label: "Open Posts", cls: "green" },
    { icon: "🔴", value: m.closed, label: "Closed Posts", cls: "red" }
  ];
  kpisEl.innerHTML = items.map(i => `
    <div class="kpi-card ${i.cls}">
      <div class="kpi-top"><span class="kpi-label">${i.label}</span><span class="kpi-icon">${i.icon}</span></div>
      <div class="kpi-value">${i.value}</div>
    </div>`).join("");
}

function renderOverallChart(m) {
  if (!overallCanvas) return;
  const ctx = overallCanvas.getContext("2d");
  const w = overallCanvas.width, h = overallCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const data = postDataCache.map((p, i) => ({ label: p.post.title || "Untitled", value: p.total, color: COLORS[i % COLORS.length] }));
  if (data.length === 0) { clearCanvas(overallCanvas, "No data"); return; }

  const pad = { l: 46, r: 20, t: 20, b: 70 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  const maxV = Math.max(1, ...data.map(d => d.value));
  const gap = Math.max(10, cw * 0.03);
  const barW = Math.max(18, (cw - gap * (data.length + 1)) / data.length);

  // grid
  ctx.strokeStyle = "rgba(11,31,77,0.12)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch - (ch * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
    ctx.fillStyle = "#5b6b86"; ctx.font = "600 12px Segoe UI, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(String(Math.round((maxV * i) / 4)), pad.l - 8, y);
  }
  ctx.strokeStyle = "rgba(11,31,77,0.25)";
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ch); ctx.lineTo(pad.l + cw, pad.t + ch); ctx.stroke();

  data.forEach((d, i) => {
    const bh = (d.value / maxV) * ch;
    const x = pad.l + gap + i * (barW + gap);
    const y = pad.t + ch - bh;
    drawRoundedBar(ctx, x, y, barW, bh, 8, d.color);
    ctx.fillStyle = "#0b1f4d"; ctx.font = "700 13px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(String(d.value), x + barW / 2, y - 4);

    const label = d.label.length > 12 ? d.label.slice(0, 11) + "…" : d.label;
    ctx.save();
    ctx.translate(x + barW / 2, pad.t + ch + 10);
    ctx.rotate(-Math.PI / 7);
    ctx.fillStyle = "#334155"; ctx.font = "600 12px Segoe UI, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
}

function renderStatus(m) {
  if (statusCanvas) {
    const ctx = statusCanvas.getContext("2d");
    const w = statusCanvas.width, h = statusCanvas.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.36;
    ctx.clearRect(0, 0, w, h);
    const parts = [
      { label: "Open", value: m.open, color: "#16a34a" },
      { label: "Closed", value: m.closed, color: "#ff2d55" }
    ];
    const total = m.open + m.closed || 1;
    let start = -Math.PI / 2;
    parts.forEach(p => {
      const slice = (p.value / total) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + slice); ctx.closePath();
      ctx.fillStyle = p.value === 0 ? "#e2e8f0" : p.color; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 3; ctx.stroke();
      start += slice;
    });
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
    ctx.fillStyle = "#0b1f4d"; ctx.font = "800 28px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(m.totalPosts), cx, cy - 6);
    ctx.fillStyle = "#5b6b86"; ctx.font = "700 13px Segoe UI, sans-serif";
    ctx.fillText("posts", cx, cy + 16);
  }
  if (statusLegendEl) {
    statusLegendEl.innerHTML = `
      <div class="mini-legend-item"><span><i class="dot" style="background:#16a34a"></i> Open</span><b>${m.open}</b></div>
      <div class="mini-legend-item"><span><i class="dot" style="background:#ff2d55"></i> Closed</span><b>${m.closed}</b></div>
    `;
  }
}

function renderParticipation(m) {
  if (!participationEl) return;
  const pct = Math.round(m.participation);
  participationEl.innerHTML = `
    <div class="ring-row">
      <div class="ring" style="--pct:${pct}">
        <div class="ring-inner"><div><strong>${pct}%</strong><br><small>Active</small></div></div>
      </div>
      <div class="part-stats">
        <div>Posts with votes: <b>${m.activePosts}</b> / ${m.totalPosts}</div>
        <div>Posts with no votes: <b>${m.totalPosts - m.activePosts}</b></div>
        <div>Avg. votes per post: <b>${fmt(m.avgVotes)}</b></div>
        <div>Total ballots recorded: <b>${m.totalVotes}</b></div>
      </div>
    </div>
  `;
}

function renderLeaderboard(m) {
  if (!leaderboardEl) return;
  const top = m.allCands.slice(0, 8);
  if (top.length === 0) { leaderboardEl.innerHTML = `<p class="empty-msg">No candidates yet.</p>`; return; }
  leaderboardEl.innerHTML = top.map((c, i) => `
    <div class="leader-row">
      <div class="rank ${i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : ""}">${i + 1}</div>
      <div class="leader-info">
        <div class="name">${escapeHtml(c.name || "Unnamed")}</div>
        <div class="post">${escapeHtml(c.postTitle)}</div>
      </div>
      <div class="leader-votes"><strong>${Number(c.votes) || 0}</strong><small>votes</small></div>
    </div>`).join("");
}

function renderInsights(m) {
  if (!insightsEl) return;
  const items = [];
  if (m.most) items.push({ ico: "🔥", title: "Most Voted Post", text: `${m.most.post.title || "Untitled"} leads with ${m.most.total} vote(s).` });
  if (m.least) items.push({ ico: "📉", title: "Least Voted Post", text: `${m.least.post.title || "Untitled"} has ${m.least.total} vote(s).` });
  if (m.allCands.length > 0) items.push({ ico: "🏆", title: "Top Candidate Overall", text: `${m.allCands[0].name || "Unnamed"} (${m.allCands[0].postTitle}) with ${Number(m.allCands[0].votes) || 0} vote(s).` });
  items.push({ ico: "⚖️", title: "Tied Races", text: m.ties > 0 ? `${m.ties} post(s) currently have a tie for first place.` : "No ties at the top right now." });
  items.push({ ico: "📈", title: "Participation", text: `${fmt(m.participation, 0)}% of posts have received at least one vote.` });
  items.push({ ico: "🗳️", title: "Vote Volume", text: `${m.totalVotes} total vote(s) across ${m.totalPosts} post(s) (avg ${fmt(m.avgVotes)} per post).` });

  insightsEl.innerHTML = items.map(it => `
    <div class="insight-item">
      <div class="insight-ico">${it.ico}</div>
      <div><h4>${escapeHtml(it.title)}</h4><p>${escapeHtml(it.text)}</p></div>
    </div>`).join("");
}

function renderPosts(m) {
  container.innerHTML = "";
  postDataCache.forEach((p, idx) => {
    const leader = p.candidates[0];
    const leaderVotes = leader ? (Number(leader.votes) || 0) : 0;
    const share = p.total > 0 ? Math.round((leaderVotes / p.total) * 100) : 0;
    const card = document.createElement("section");
    card.className = "card post-stat-card";

    const candsHtml = p.candidates.length ? p.candidates.map((c, i) => {
      const v = Number(c.votes) || 0;
      const pct = p.total > 0 ? Math.round((v / p.total) * 100) : 0;
      const color = COLORS[i % COLORS.length];
      const isLeader = i === 0 && p.total > 0;
      const isRunnerUp = i === 1 && p.total > 0;
      const badge = isLeader ? `<span class="pill gold">Leading</span>` : isRunnerUp ? `<span class="pill gray">1st Runner-Up</span>` : "";
      return `<div class="cand-row">
        <span class="swatch" style="background:${color}"></span>
        <span class="nm" title="${escapeAttr(c.name || "Unnamed")}">${escapeHtml(c.name || "Unnamed")} ${badge}</span>
        <span class="vl">${v} (${pct}%)</span>
        <div class="barline"><i style="width:${pct}%;background:${color}"></i></div>
      </div>`;
    }).join("") : `<p class="empty-msg">No candidates.</p>`;

    card.innerHTML = `
      <div class="post-stat-head">
        <div>
          <h3>${escapeHtml(p.post.title || "Untitled")}</h3>
          <div class="post-meta-row">
            <span class="badge ${p.post.status === "closed" ? "closed" : ""}">${p.post.status === "closed" ? "Closed" : "Open"}</span>
            <span class="pill blue">${p.total} vote(s)</span>
            <span class="pill gray">${p.candidates.length} candidate(s)</span>
            ${leader && p.total > 0 ? `<span class="pill gold">Leader: ${escapeHtml(leader.name || "Unnamed")} (${share}%)</span>` : ""}
            ${p.candidates[1] && p.total > 0 ? `<span class="pill gray">1st Runner-Up: ${escapeHtml(p.candidates[1].name || "Unnamed")} (${Math.round(((Number(p.candidates[1].votes) || 0) / p.total) * 100)}%)</span>` : ""}
          </div>
        </div>
      </div>
      <div class="post-viz"><canvas id="post-viz-${idx}" width="520" height="300"></canvas></div>
      <div class="cand-list">${candsHtml}</div>
    `;
    container.appendChild(card);

    const canvas = card.querySelector("canvas");
    if (canvas) {
      if (viewMode === "chart") drawDonut(canvas, p.candidates, p.total);
      else drawHBar(canvas, p.candidates, p.total);
    }
  });
}

function drawDonut(canvas, candidates, total) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.36;
  ctx.clearRect(0, 0, w, h);
  if (!candidates.length || total === 0) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = "#e2e8f0"; ctx.fill();
    ctx.fillStyle = "#64748b"; ctx.font = "700 18px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(total === 0 && candidates.length ? "No votes yet" : "No data", cx, cy);
    return;
  }
  let start = -Math.PI / 2;
  candidates.forEach((c, i) => {
    const val = Number(c.votes) || 0;
    if (val <= 0) return;
    const slice = (val / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + slice); ctx.closePath();
    ctx.fillStyle = COLORS[i % COLORS.length]; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 2; ctx.stroke();
    start += slice;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.56, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.fillStyle = "#0b1f4d"; ctx.font = "800 26px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(total), cx, cy - 6);
  ctx.fillStyle = "#5b6b86"; ctx.font = "700 13px Segoe UI, sans-serif";
  ctx.fillText("total votes", cx, cy + 16);

  // small legend dots on right if space
  const lx = w * 0.72, ly = h * 0.18;
  ctx.font = "600 11px Segoe UI, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  candidates.slice(0, 5).forEach((c, i) => {
    const y = ly + i * 18;
    ctx.fillStyle = COLORS[i % COLORS.length]; ctx.fillRect(lx, y - 5, 10, 10);
    const nm = (c.name || "Unnamed");
    ctx.fillStyle = "#334155"; ctx.fillText(nm.length > 12 ? nm.slice(0, 11) + "…" : nm, lx + 14, y);
  });
}

function drawHBar(canvas, candidates, total) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!candidates.length) { clearCanvas(canvas, "No candidates"); return; }
  const pad = { l: 130, r: 50, t: 18, b: 18 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  const n = candidates.length;
  const maxV = Math.max(1, ...candidates.map(c => Number(c.votes) || 0));
  const gap = Math.max(8, ch * 0.08 / n);
  const barH = Math.max(14, (ch - gap * (n + 1)) / n);

  ctx.strokeStyle = "rgba(11,31,77,0.12)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = pad.l + (cw * i) / 4;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch); ctx.stroke();
    ctx.fillStyle = "#64748b"; ctx.font = "600 11px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(String(Math.round((maxV * i) / 4)), x, pad.t + ch + 2);
  }

  candidates.forEach((c, i) => {
    const val = Number(c.votes) || 0;
    const bw = (val / maxV) * cw;
    const y = pad.t + gap + i * (barH + gap);
    const color = COLORS[i % COLORS.length];
    drawRoundedBar(ctx, pad.l, y, Math.max(bw, 0), barH, 6, color);

    const name = c.name || "Unnamed";
    ctx.fillStyle = "#334155"; ctx.font = "700 12px Segoe UI, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(name.length > 16 ? name.slice(0, 15) + "…" : name, pad.l - 8, y + barH / 2);

    ctx.fillStyle = "#0b1f4d"; ctx.textAlign = "left";
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    ctx.fillText(`${val} (${pct}%)`, pad.l + bw + 6, y + barH / 2);
  });
}

function drawRoundedBar(ctx, x, y, w, h, r, color) {
  const hh = Math.max(h, 0), rr = Math.min(r, w / 2 || 0, hh / 2 || 0);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + hh - rr);
  ctx.quadraticCurveTo(x + w, y + hh, x + w - rr, y + hh);
  ctx.lineTo(x + rr, y + hh);
  ctx.quadraticCurveTo(x, y + hh, x, y + hh - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function clearCanvas(canvas, text = "No data") {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#64748b"; ctx.font = "700 16px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/`/g, "&#96;"); }

(async () => {
  const ok = await requireAdmin();
  if (ok) loadStats();
})();
