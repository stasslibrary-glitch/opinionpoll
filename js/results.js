import { db, showConfigWarning } from "./firebase.js";
import { collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const container = document.getElementById("results-container");

let allResultsData = [];

function setLoading(show) {
  if (!container) return;
  if (show) {
    container.innerHTML = `<div class="card"><p class="muted">Loading results...</p></div>`;
  }
}

function setError(msg) {
  if (!container) return;
  container.innerHTML = `<div class="card"><p class="message error">${msg}</p></div>`;
}

function setEmpty() {
  if (!container) return;
  container.innerHTML = `<div class="card"><h3>No results yet</h3><p class="muted">No posts have been created.</p></div>`;
}

async function loadResults() {
  if (!container) return;
  setLoading(true);

  if (showConfigWarning(document) || !db) {
    setError("Firebase not configured. Check js/firebase-config.js and browser console.");
    return;
  }

  try {
    console.log("[results] fetching posts...");
    const postsSnap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "asc")));
    console.log("[results] posts found:", postsSnap.size);

    if (postsSnap.empty) {
      setEmpty();
      return;
    }

    const postData = await Promise.all(postsSnap.docs.map(async (postDoc) => {
      const post = { id: postDoc.id, ...postDoc.data() };
      try {
        const candidatesSnap = await getDocs(query(collection(db, "candidates"), where("postId", "==", post.id)));
        const candidates = candidatesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        candidates.sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0));
        return { post, candidates, error: null };
      } catch (err) {
        console.error("[results] candidate load error for post", post.id, err);
        return { post, candidates: [], error: err };
      }
    }));

    console.log("[results] rendering", postData.length, "posts");
    container.innerHTML = "";
    allResultsData = postData;
    postData.forEach(({ post, candidates, error }) => {
      if (error) {
        container.insertAdjacentHTML("beforeend", `<div class="message error">Could not load candidates for "${escapeHtml(post.title || post.id)}": ${escapeHtml(error.message)}</div>`);
      }
      container.appendChild(renderPostResults(post, candidates));
    });
    animateChargeBars(container);
    wirePublishButtons();
  } catch (err) {
    console.error("[results] load failed:", err);
    setError(`Failed to load results: ${err.message}`);
  }
}

function renderPostResults(post, candidates) {
  const total = candidates.reduce((sum, c) => sum + (Number(c.votes) || 0), 0);
  const closed = post.status === "closed";
  const leaderVotes = candidates.length ? Math.max(...candidates.map(c => Number(c.votes) || 0)) : 0;
  const sortedVotes = candidates.map(c => Number(c.votes) || 0).sort((a, b) => b - a);
  const runnerUpVotes = sortedVotes.length > 1 ? sortedVotes[1] : 0;

  const card = document.createElement("section");
  card.className = "card post-card";
  card.innerHTML = `
    <div class="post-header">
      <div>
        <h2>${escapeHtml(post.title || "Untitled Post")}</h2>
        ${post.description ? `<p class="muted small">${escapeHtml(post.description)}</p>` : ""}
      </div>
      <div class="stack" style="align-items:flex-end">
        <span class="badge ${closed ? "closed" : ""}">${closed ? "Closed" : "Open"}</span>
        <span class="muted small">Total votes: <strong>${total}</strong></span>
        <button type="button" class="btn publish-post-btn" data-post-id="${escapeAttr(post.id)}" title="Publish results for this post">Publish R</button>
      </div>
    </div>
    <div class="candidates"></div>
  `;

  const list = card.querySelector(".candidates");
  if (candidates.length === 0) {
    list.innerHTML = `<p class="muted">No candidates for this post.</p>`;
    return card;
  }

  candidates.forEach(c => {
    const votes = Number(c.votes) || 0;
    const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
    const isLeader = total > 0 && votes === leaderVotes;
    const isRunnerUp = total > 0 && votes === runnerUpVotes && !isLeader;
    const row = document.createElement("div");
    row.className = "candidate";
    row.innerHTML = `
      <div class="candidate-info" style="width:100%">
        <div class="row" style="justify-content:space-between">
          <div class="candidate-name">${escapeHtml(c.name || "Unnamed")} ${isLeader ? '<span class="badge">Leading</span>' : isRunnerUp ? '<span class="badge runnerup">1st Runner-Up</span>' : ""}</div>
          <div class="vote-count">${votes} (${pct}%)</div>
        </div>
        <div class="bar-wrap" aria-hidden="true"><div class="bar charge-bar" data-width="${pct}" style="width:0%"></div></div>
      </div>
    `;
    list.appendChild(row);
  });

  return card;
}

function animateChargeBars(root = document) {
  const bars = Array.from((root || document).querySelectorAll(".bar[data-width]"));
  if (bars.length === 0) return;
  const reveal = (bar) => {
    if (bar.dataset.animated === "1") return;
    bar.dataset.animated = "1";
    const target = Number(bar.dataset.width) || 0;
    requestAnimationFrame(() => { bar.style.width = `${target}%`; });
  };
  if (!("IntersectionObserver" in window)) {
    bars.forEach(reveal);
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        reveal(entry.target);
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.2, rootMargin: "0px 0px -5% 0px" });
  bars.forEach(bar => io.observe(bar));
}

function wirePublishButtons() {
  document.querySelectorAll(".publish-post-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const postId = btn.dataset.postId;
      const postData = allResultsData.find(d => d.post.id === postId);
      if (!postData) return;
      downloadSinglePostPDF(postData.post, postData.candidates);
    });
  });
}

function downloadSinglePostPDF(post, candidates) {
  const section = document.createElement("div");
  section.id = "single-post-pdf-section";
  section.className = "single-post-pdf-section hidden";
  const total = candidates.reduce((s, c) => s + (Number(c.votes) || 0), 0);
  const closed = post.status === "closed";
  const leaderVotes = candidates.length ? Math.max(...candidates.map(c => Number(c.votes) || 0)) : 0;
  const sortedVotes = candidates.map(c => Number(c.votes) || 0).sort((a, b) => b - a);
  const runnerUpVotes = sortedVotes.length > 1 ? sortedVotes[1] : 0;

  const rows = candidates.map((c, i) => {
    const v = Number(c.votes) || 0;
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    const isLeader = total > 0 && v === leaderVotes;
    const isRunnerUp = total > 0 && v === runnerUpVotes && !isLeader;
    return `
      <div class="pdf-cand-row ${isLeader ? 'pdf-cand-winner' : isRunnerUp ? 'pdf-cand-runnerup' : ''}">
        <span class="pdf-cand-num">${i + 1}</span>
        <span class="pdf-cand-name">${escapeHtml(c.name || "Unnamed")} ${isLeader ? '<span style="color:#d97706;font-weight:900">★ Leading</span>' : isRunnerUp ? '<span style="color:#64748b;font-weight:900">1st Runner-Up</span>' : ""}</span>
        <span class="pdf-cand-votes">${v}</span>
        <span class="pdf-cand-pct">${pct}%</span>
      </div>
    `;
  }).join("");

  section.innerHTML = `
    <div class="pdf-page">
      <div class="pdf-confetti"></div>

      <div class="pdf-header">
        <div class="pdf-school">
          <img src="badge.png" alt="Badge" class="pdf-badge-img">
          <div class="pdf-brand">
            <div class="pdf-eyebrow">ST. THOMAS AQUINAS S.S. KAWEMPE</div>
            <div class="pdf-title">End of Year Opinion Poll</div>
            <div class="pdf-motto">&ldquo;The Source Of Knowledge And Wisdom&rdquo;</div>
          </div>
        </div>
        <div class="pdf-meta">
          <div><strong>Generated:</strong> <span id="single-pdf-date"></span></div>
          <div><strong>Document:</strong> Results for a Single Post</div>
        </div>
      </div>

      <div class="pdf-divider"></div>

      <div class="pdf-section">
        <h2><span>📋</span> Post Results</h2>
        <div class="pdf-single-post">
          <div class="pdf-post-title-big">${escapeHtml(post.title || "Untitled Post")}</div>
          ${post.description ? `<div class="pdf-post-desc">${escapeHtml(post.description)}</div>` : ""}
          <div class="pdf-post-meta">
            <span class="pdf-post-badge ${closed ? "closed" : "open"}">${closed ? "CLOSED" : "OPEN"}</span>
            <span class="pdf-post-total"><strong>${total}</strong> total vote(s)</span>
            <span class="pdf-post-cands">${candidates.length} candidate(s)</span>
          </div>
        </div>
      </div>

      <div class="pdf-section">
        <h2><span>🗳️</span> Candidates &amp; Votes</h2>
        <div class="pdf-cand-table">
          <div class="pdf-cand-head">
            <span>#</span><span>Candidate</span><span style="text-align:right">Votes</span><span style="text-align:right">%</span>
          </div>
          ${rows || `<div style="text-align:center;color:#94a3b8;padding:1rem">No candidates yet</div>`}
        </div>
      </div>

      <div class="pdf-footer">
        <div class="pdf-signature">
          <div class="sig-line"></div>
          <div class="sig-label">Returning Officer</div>
        </div>
        <div class="pdf-signature">
          <div class="sig-line"></div>
          <div class="sig-label">Ernest Cruz</div>
        </div>  
        <div class="pdf-note">
        St. Thomas Aquinas Secondary School, Kawempe &mdash; Official Post Result</div>
      </div>

      <div class="pdf-confetti" style="top:auto;bottom:0;transform:rotate(180deg);"></div>
    </div>
  `;
  document.body.appendChild(section);

  document.getElementById("single-pdf-date").textContent = new Date().toLocaleString();

  section.classList.remove("hidden");
  setTimeout(() => window.print(), 400);
  setTimeout(() => section.classList.add("hidden"), 2000);
  setTimeout(() => section.remove(), 3000);
}

// --- Colorful PDF download for results page ---
function buildResultsPDF() {
  const section = document.createElement("div");
  section.id = "results-pdf-section";
  section.className = "results-pdf-section hidden";
  section.innerHTML = `
    <div class="pdf-page">
      <div class="pdf-confetti"></div>

      <div class="pdf-header">
        <div class="pdf-school">
          <img src="badge.png" alt="Badge" class="pdf-badge-img">
          <div class="pdf-brand">
            <div class="pdf-eyebrow">ST. THOMAS AQUINAS S.S. KAWEMPE</div>
            <div class="pdf-title">End of Year Opinion Poll</div>
            <div class="pdf-motto">&ldquo;The Source Of Knowledge And Wisdom&rdquo;</div>
          </div>
        </div>
        <div class="pdf-meta">
          <div><strong>Generated:</strong> <span id="results-pdf-date"></span></div>
          <div><strong>Document:</strong> Official Poll Results</div>
        </div>
      </div>

      <div class="pdf-divider"></div>

      <div class="pdf-section">
        <h2><span>📊</span> Poll Summary</h2>
        <div class="pdf-summary-grid" id="results-pdf-summary-grid"></div>
      </div>

      <div class="pdf-section">
        <h2><span>🏆</span> Results by Post</h2>
        <div class="pdf-results-list" id="results-pdf-list"></div>
      </div>

      <div class="pdf-footer">
        <div class="pdf-signature">
          <div class="sig-line"></div>
          <div class="sig-label">Returning Officer</div>
        </div>
        <div class="pdf-signature">
          <div class="sig-line"></div>
          <div class="sig-label">Cruz Heist</div>
        </div>
        <div class="pdf-note">St. Thomas Aquinas Secondary School, Kawempe &mdash; Official Election Document</div>
      </div>

      <div class="pdf-confetti" style="top:auto;bottom:0;transform:rotate(180deg);"></div>
    </div>
  `;
  document.body.appendChild(section);
  return section;
}

function populateResultsPDF() {
  const grid = document.getElementById("results-pdf-summary-grid");
  const list = document.getElementById("results-pdf-list");
  const dateEl = document.getElementById("results-pdf-date");

  if (dateEl) dateEl.textContent = new Date().toLocaleString();

  let totalPosts = 0, totalVotes = 0, totalCandidates = 0, openPosts = 0, closedPosts = 0;

  const postBlocks = allResultsData.map(({ post, candidates }) => {
    totalPosts++;
    const total = candidates.reduce((s, c) => s + (Number(c.votes) || 0), 0);
    totalVotes += total;
    totalCandidates += candidates.length;
    if (post.status === "closed") closedPosts++; else openPosts++;

  const leaderVotes = candidates.length ? Math.max(...candidates.map(c => Number(c.votes) || 0)) : 0;
  // Second highest votes (runner-up)
  const sortedVotes = candidates.map(c => Number(c.votes) || 0).sort((a, b) => b - a);
  const runnerUpVotes = sortedVotes.length > 1 ? sortedVotes[1] : 0;
    const rows = candidates.map((c, i) => {
      const v = Number(c.votes) || 0;
      const pct = total > 0 ? Math.round((v / total) * 100) : 0;
      const isLeader = total > 0 && v === leaderVotes;
      const isRunnerUp = total > 0 && v === runnerUpVotes && !isLeader;
      return `
        <div class="pdf-cand-row ${isLeader ? 'pdf-cand-winner' : isRunnerUp ? 'pdf-cand-runnerup' : ''}">
          <span class="pdf-cand-num">${i + 1}</span>
          <span class="pdf-cand-name">${escapeHtml(c.name || "Unnamed")} ${isLeader ? '<span style="color:#d97706;font-weight:900">★ Leading</span>' : isRunnerUp ? '<span style="color:#64748b;font-weight:900">1st Runner-Up</span>' : ""}</span>
          <span class="pdf-cand-votes">${v}</span>
          <span class="pdf-cand-pct">${pct}%</span>
        </div>
      `;
    }).join("");

    return `
      <div class="pdf-post-block">
        <div class="pdf-post-header">
          <span class="pdf-post-title">${escapeHtml(post.title || "Untitled")}</span>
          <span class="pdf-post-badge ${post.status === "closed" ? "closed" : "open"}">${post.status === "closed" ? "CLOSED" : "OPEN"}</span>
        </div>
        <div class="pdf-post-total"><strong>${total}</strong> total vote(s) &middot; ${candidates.length} candidate(s)</div>
        <div class="pdf-cand-table">
          <div class="pdf-cand-head">
            <span>#</span><span>Candidate</span><span style="text-align:right">Votes</span><span style="text-align:right">%</span>
          </div>
          ${rows || `<div style="text-align:center;color:#94a3b8;padding:1rem">No candidates yet</div>`}
        </div>
      </div>
    `;
  }).join("");

  if (grid) grid.innerHTML = `
    <div class="pdf-sum-card"><div class="pdf-sum-val">${totalPosts}</div><div class="pdf-sum-lab">Total Posts</div></div>
    <div class="pdf-sum-card"><div class="pdf-sum-val">${totalVotes}</div><div class="pdf-sum-lab">Total Votes</div></div>
    <div class="pdf-sum-card"><div class="pdf-sum-val">${totalCandidates}</div><div class="pdf-sum-lab">Candidates</div></div>
    <div class="pdf-sum-card"><div class="pdf-sum-val">${totalPosts ? Math.round((totalVotes / totalPosts) * 10) / 10 : 0}</div><div class="pdf-sum-lab">Avg Votes / Post</div></div>
    <div class="pdf-sum-card"><div class="pdf-sum-val">${openPosts}</div><div class="pdf-sum-lab">Open Posts</div></div>
    <div class="pdf-sum-card"><div class="pdf-sum-val">${closedPosts}</div><div class="pdf-sum-lab">Closed Posts</div></div>
  `;

  if (list) list.innerHTML = postBlocks || `<div class="pdf-empty">No results yet.</div>`;
}

if (document.getElementById("download-results-pdf")) {
  document.getElementById("download-results-pdf").addEventListener("click", () => {
    const section = document.getElementById("results-pdf-section") || buildResultsPDF();
    populateResultsPDF();
    section.classList.remove("hidden");
    setTimeout(() => window.print(), 400);
    setTimeout(() => section.classList.add("hidden"), 2000);
  });
}

(async () => {
  await loadResults();
})();

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/`/g, "&#96;"); }