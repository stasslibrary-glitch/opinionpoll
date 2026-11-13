import { auth, db, showConfigWarning } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, getDocs, getDoc, doc, query, where, orderBy, limit,
  updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const msg = document.getElementById("admin-message");
const postsContainer = document.getElementById("admin-posts");
const postForm = document.getElementById("post-form");
const candidateForm = document.getElementById("candidate-form");
const candidatePostSelect = document.getElementById("candidate-post");
const votesLog = document.getElementById("votes-log");
const logoutBtn = document.getElementById("logout-btn");
const endVotingBtn = document.getElementById("end-voting-btn");

let postsCache = [];
let candidatesByPost = {};

function setMessage(text, type = "info") {
  msg.textContent = text;
  msg.className = `message ${type}`;
  msg.classList.remove("hidden");
  if (type === "success") setTimeout(() => msg.classList.add("hidden"), 3000);
}

async function isAdmin(uid) {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists();
}

async function requireAdmin() {
  if (showConfigWarning(document)) return false;
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = "admin-login.html";
        resolve(false);
        return;
      }
      try {
        const ok = await isAdmin(user.uid);
        if (!ok) {
          await signOut(auth);
          window.location.href = "admin-login.html";
          resolve(false);
          return;
        }
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

async function loadAll() {
  try {
    await loadPosts();
  } catch (err) {
    console.error(err);
    setMessage(`Could not load posts: ${err.message}`, "error");
    if (postsCache.length === 0) {
      postsContainer.innerHTML = `<div class="card"><p class="message error">Could not load posts: ${escapeHtml(err.message)}</p></div>`;
    }
  }
  try {
    await loadVotesLog();
  } catch (err) {
    console.error(err);
  }
}

async function loadPosts() {
  const postsSnap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "asc")));
  postsCache = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  candidatePostSelect.innerHTML = `<option value="">Select a post</option>`;
  postsCache.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title || p.id;
    candidatePostSelect.appendChild(opt);
  });

  candidatesByPost = {};
  const candidateResults = await Promise.all(postsCache.map(async (post) => {
    try {
      const snap = await getDocs(query(collection(db, "candidates"), where("postId", "==", post.id)));
      const candidates = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      return { postId: post.id, candidates, error: null };
    } catch (err) {
      console.error(err);
      return { postId: post.id, candidates: [], error: err };
    }
  }));

  let candidateError = null;
  candidateResults.forEach(({ postId, candidates, error }) => {
    candidatesByPost[postId] = candidates;
    if (error && !candidateError) candidateError = error;
  });

  renderAdminPosts();
  if (candidateError) {
    setMessage(`Posts loaded, but some candidate details could not load: ${candidateError.message}`, "error");
  }
}

function renderAdminPosts() {
  if (postsCache.length === 0) {
    postsContainer.innerHTML = `<div class="card"><p class="muted">No posts yet. Create one above.</p></div>`;
    return;
  }
  postsContainer.innerHTML = "";
  postsCache.forEach(post => {
    const candidates = candidatesByPost[post.id] || [];
    const total = candidates.reduce((s, c) => s + (Number(c.votes) || 0), 0);
    const closed = post.status === "closed";
    const card = document.createElement("section");
    card.className = "card post-card";
    card.innerHTML = `
      <div class="post-header">
        <div>
          <h3>${escapeHtml(post.title || "Untitled")}</h3>
          ${post.description ? `<p class="muted small">${escapeHtml(post.description)}</p>` : ""}
          <p class="muted small">Total votes: <strong>${total}</strong></p>
        </div>
        <div class="row">
          <span class="badge ${closed ? "closed" : ""}">${closed ? "Closed" : "Open"}</span>
          <button class="btn secondary small toggle-btn">${closed ? "Reopen" : "Close"}</button>
          <button class="btn danger small delete-post-btn">Delete</button>
        </div>
      </div>
      <div class="candidates"></div>
    `;

    const list = card.querySelector(".candidates");
    if (candidates.length === 0) {
      list.innerHTML = `<p class="muted">No candidates yet.</p>`;
    } else {
      candidates.forEach(c => {
        const row = document.createElement("div");
        row.className = "candidate";
        const votes = Number(c.votes) || 0;
        const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
        row.innerHTML = `
          <div class="candidate-info" style="width:100%">
            <div class="row" style="justify-content:space-between">
              <div class="candidate-name">${escapeHtml(c.name || "Unnamed")}</div>
              <div class="vote-count">${votes} vote(s) · ${pct}%</div>
            </div>
            <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
          </div>
          <button class="btn danger small delete-candidate-btn">Remove</button>
        `;
        row.querySelector(".delete-candidate-btn").addEventListener("click", () => removeCandidate(c.id, post.id));
        list.appendChild(row);
      });
    }

    card.querySelector(".toggle-btn").addEventListener("click", () => togglePost(post));
    card.querySelector(".delete-post-btn").addEventListener("click", () => removePost(post.id));
    postsContainer.appendChild(card);
  });
}

async function loadVotesLog() {
  try {
    const snap = await getDocs(query(collection(db, "votes"), orderBy("createdAt", "desc"), limit(20)));
    if (snap.empty) {
      votesLog.innerHTML = `<p class="muted">No vote records yet.</p>`;
      return;
    }
    const postNames = Object.fromEntries(postsCache.map(p => [p.id, p.title || p.id]));
    const candNames = {};
    Object.values(candidatesByPost).flat().forEach(c => { candNames[c.id] = c.name || c.id; });

    let html = `<table><thead><tr><th>Post</th><th>Candidate</th><th>Time</th></tr></thead><tbody>`;
    snap.forEach(d => {
      const v = d.data();
      const time = v.createdAt && v.createdAt.toDate ? v.createdAt.toDate().toLocaleString() : "—";
      html += `<tr><td>${escapeHtml(postNames[v.postId] || v.postId || "—")}</td><td>${escapeHtml(candNames[v.candidateId] || v.candidateId || "—")}</td><td class="small muted">${escapeHtml(time)}</td></tr>`;
    });
    html += `</tbody></table>`;
    votesLog.innerHTML = html;
  } catch (err) {
    console.error(err);
    votesLog.innerHTML = `<p class="message error">Could not load vote records: ${err.message}</p>`;
  }
}

postForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = postForm.title.value.trim();
  const description = postForm.description.value.trim();
  if (!title) return;
  try {
    await addDoc(collection(db, "posts"), {
      title, description, status: "open", totalVotes: 0, createdAt: serverTimestamp()
    });
    postForm.reset();
    setMessage("Post created.", "success");
    await loadAll();
  } catch (err) {
    console.error(err);
    setMessage(`Failed to create post: ${err.message}`, "error");
  }
});

candidateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const postId = candidateForm.postId.value;
  const name = candidateForm.name.value.trim();
  if (!postId || !name) return;
  try {
    await addDoc(collection(db, "candidates"), {
      postId, name, votes: 0, createdAt: serverTimestamp()
    });
    candidateForm.name.value = "";
    setMessage("Candidate added.", "success");
    await loadAll();
  } catch (err) {
    console.error(err);
    setMessage(`Failed to add candidate: ${err.message}`, "error");
  }
});

async function togglePost(post) {
  try {
    await updateDoc(doc(db, "posts", post.id), { status: post.status === "closed" ? "open" : "closed" });
    setMessage(`Post ${post.status === "closed" ? "reopened" : "closed"}.`, "success");
    await loadAll();
  } catch (err) {
    console.error(err);
    setMessage(`Failed to update post: ${err.message}`, "error");
  }
}

async function removeCandidate(candidateId, postId) {
  if (!confirm("Remove this candidate? (Votes for them remain in records but the candidate will be deleted.)")) return;
  try {
    await deleteDoc(doc(db, "candidates", candidateId));
    setMessage("Candidate removed.", "success");
    await loadAll();
  } catch (err) {
    console.error(err);
    setMessage(`Failed to remove candidate: ${err.message}`, "error");
  }
}

async function removePost(postId) {
  if (!confirm("Delete this post and all its candidates?")) return;
  try {
    const candidates = candidatesByPost[postId] || [];
    for (const c of candidates) {
      await deleteDoc(doc(db, "candidates", c.id));
    }
    await deleteDoc(doc(db, "posts", postId));
    setMessage("Post deleted.", "success");
    await loadAll();
  } catch (err) {
    console.error(err);
    setMessage(`Failed to delete post: ${err.message}`, "error");
  }
}

async function endVotingAndShowWinners() {
  if (postsCache.length === 0) {
    setMessage("No posts to end. Create posts first.", "error");
    return;
  }
  const ok = confirm("End voting for all posts and view winners?\n\nThis will close all open posts so no more votes can be cast.");
  if (!ok) return;
  try {
    if (endVotingBtn) { endVotingBtn.disabled = true; endVotingBtn.textContent = "Ending..."; }
    await Promise.all(postsCache.map(p => updateDoc(doc(db, "posts", p.id), { status: "closed" })));
    setMessage("Voting ended. Redirecting to winners...", "success");
    window.location.href = "winners.html";
  } catch (err) {
    console.error(err);
    setMessage(`Failed to end voting: ${err.message}`, "error");
    if (endVotingBtn) { endVotingBtn.disabled = false; endVotingBtn.textContent = "End Voting & Show Winners"; }
  }
}

if (endVotingBtn) endVotingBtn.addEventListener("click", endVotingAndShowWinners);

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "admin-login.html";
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

(async () => {
  const ok = await requireAdmin();
  if (ok) loadAll();
})();
