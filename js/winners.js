import { auth, db, showConfigWarning } from "./firebase.js";
import { collection, getDocs, getDoc, doc, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const container = document.getElementById("winners-container");
const messageEl = document.getElementById("winners-message");
const logoutBtn = document.getElementById("logout-btn");

function setMessage(text, type = "info") {
  if (!messageEl) return;
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.classList.toggle("hidden", !text);
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

async function loadWinners() {
  if (!container) return;

  try {
    const postsSnap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "asc")));
    if (postsSnap.empty) {
      container.innerHTML = `<div class="card"><h3>No posts found</h3><p class="muted">There are no posts to show winners for.</p></div>`;
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
    let hadError = false;
    postData.forEach(({ post, candidates, error }) => {
      if (error) {
        hadError = true;
        container.insertAdjacentHTML("beforeend", `<div class="message error">Could not load candidates for "${escapeHtml(post.title || post.id)}": ${escapeHtml(error.message)}</div>`);
      }
      container.appendChild(renderWinnerCard(post, candidates));
    });
    if (hadError) setMessage("Some winner data could not be loaded. Check connection or permissions.", "error");
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="card"><p class="message error">Failed to load winners: ${escapeHtml(err.message)}</p></div>`;
  }
}

function renderWinnerCard(post, candidates) {
  const total = candidates.reduce((sum, c) => sum + (Number(c.votes) || 0), 0);
  const maxVotes = candidates.length ? Math.max(...candidates.map(c => Number(c.votes) || 0)) : 0;
  const winners = maxVotes > 0 ? candidates.filter(c => (Number(c.votes) || 0) === maxVotes) : [];

  const card = document.createElement("section");
  card.className = "card winner-card";

  let winnersHtml = "";
  if (candidates.length === 0) {
    winnersHtml = `<p class="no-winner">No candidates for this post.</p>`;
  } else if (winners.length === 0 || total === 0) {
    winnersHtml = `<p class="no-winner">No votes recorded for this post.</p>`;
  } else {
    winnersHtml = `
      <div class="winner-names">
        ${winners.map(w => `
          <div class="winner-person">
            <div class="winner-identity">
              <div class="winner-trophy" aria-hidden="true">🏆</div>
              <div>
                <div class="winner-label">Winner${winners.length > 1 ? " (Tie)" : ""}</div>
                <div class="name">${escapeHtml(w.name || "Unnamed")}</div>
              </div>
            </div>
            <div class="votes-pill"><span class="votes">${Number(w.votes) || 0}</span><small>vote(s)</small></div>
          </div>
        `).join("")}
      </div>
      ${winners.length > 1 ? `<p class="winner-tie-note">Tie: ${winners.length} candidates share the top votes.</p>` : ""}
    `;
  }

  card.innerHTML = `
    <div class="post-header">
      <div>
        <span class="winner-badge">★ Winner${winners.length > 1 ? "s" : ""}</span>
        <h2 class="winner-post-title">${escapeHtml(post.title || "Untitled Post")}</h2>
        ${post.description ? `<p class="muted small">${escapeHtml(post.description)}</p>` : ""}
      </div>
      <span class="badge ${post.status === "closed" ? "closed" : ""}">${post.status === "closed" ? "Closed" : "Open"}</span>
    </div>
    ${winnersHtml}
    <p class="muted small winner-meta">Total votes: <strong>${total}</strong> &middot; Candidates: <strong>${candidates.length}</strong></p>
  `;
  return card;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

(async () => {
  const ok = await requireAdmin();
  if (ok) loadWinners();
})();
