import { auth, db, showConfigWarning } from "./firebase.js";
import { collection, getDocs, getDoc, doc, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const container = document.getElementById("results-container");
const logoutBtn = document.getElementById("logout-btn");

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

async function loadResults() {
  if (!container) return;

  try {
    const postsSnap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "asc")));
    if (postsSnap.empty) {
      container.innerHTML = `<div class="card"><h3>No results yet</h3><p class="muted">No posts have been created.</p></div>`;
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
        console.error(err);
        return { post, candidates: [], error: err };
      }
    }));

    container.innerHTML = "";
    postData.forEach(({ post, candidates, error }) => {
      if (error) {
        container.insertAdjacentHTML("beforeend", `<div class="message error">Could not load candidates for "${escapeHtml(post.title || post.id)}": ${escapeHtml(error.message)}</div>`);
      }
      container.appendChild(renderPostResults(post, candidates));
    });
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="card"><p class="message error">Failed to load results: ${err.message}</p></div>`;
  }
}

function renderPostResults(post, candidates) {
  const total = candidates.reduce((sum, c) => sum + (Number(c.votes) || 0), 0);
  const closed = post.status === "closed";
  const leaderVotes = candidates.length ? Math.max(...candidates.map(c => Number(c.votes) || 0)) : 0;

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
    const row = document.createElement("div");
    row.className = "candidate";
    row.innerHTML = `
      <div class="candidate-info" style="width:100%">
        <div class="row" style="justify-content:space-between">
          <div class="candidate-name">${escapeHtml(c.name || "Unnamed")} ${isLeader ? '<span class="badge">Leading</span>' : ""}</div>
          <div class="vote-count">${votes} (${pct}%)</div>
        </div>
        <div class="bar-wrap" aria-hidden="true"><div class="bar" style="width:${pct}%"></div></div>
      </div>
    `;
    list.appendChild(row);
  });

  return card;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

(async () => {
  const ok = await requireAdmin();
  if (ok) loadResults();
})();
