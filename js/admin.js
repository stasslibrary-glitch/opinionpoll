import { auth, db, showConfigWarning, isOfflineFirestoreError } from "./firebase.js";
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
const candidateInputsWrap = document.getElementById("candidate-inputs");
const addCandidateFieldBtn = document.getElementById("add-candidate-field");
const addCandidatesSubmitBtn = document.getElementById("add-candidates-submit");
const votesLog = document.getElementById("votes-log");
const logoutBtn = document.getElementById("logout-btn");
const endVotingBtn = document.getElementById("end-voting-btn");

const confirmModal = document.getElementById("confirm-modal");
const confirmTitleEl = document.getElementById("confirm-title");
const confirmMessageEl = document.getElementById("confirm-message");
const confirmOkBtn = document.getElementById("confirm-ok");
const confirmCancelBtn = document.getElementById("confirm-cancel");

const editModal = document.getElementById("edit-modal");
const editTitleEl = document.getElementById("edit-title");
const editFieldsEl = document.getElementById("edit-fields");
const editForm = document.getElementById("edit-form");
const editCancelBtn = document.getElementById("edit-cancel");
const editSaveBtn = document.getElementById("edit-save");

let postsCache = [];
let candidatesByPost = {};
let confirmResolver = null;
let editState = null; // { type: 'post'|'candidate', id, postId? }

function showConfirm(message, { title = "Please Confirm", confirmText = "Confirm", confirmClass = "btn danger" } = {}) {
  if (!confirmModal) return Promise.resolve(window.confirm(message));
  confirmTitleEl.textContent = title;
  confirmMessageEl.textContent = message;
  confirmOkBtn.textContent = confirmText;
  confirmOkBtn.className = confirmClass;
  confirmModal.classList.remove("hidden");
  confirmModal.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function closeConfirm(result) {
  if (!confirmModal) return;
  confirmModal.classList.add("hidden");
  confirmModal.setAttribute("aria-hidden", "true");
  const resolve = confirmResolver;
  confirmResolver = null;
  if (resolve) resolve(result);
}

if (confirmOkBtn) confirmOkBtn.addEventListener("click", () => closeConfirm(true));
if (confirmCancelBtn) confirmCancelBtn.addEventListener("click", () => closeConfirm(false));
if (confirmModal) {
  confirmModal.addEventListener("click", (e) => {
    if (e.target === confirmModal) closeConfirm(false);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (confirmModal && !confirmModal.classList.contains("hidden")) closeConfirm(false);
    if (editModal && !editModal.classList.contains("hidden")) closeEditModal();
  }
});

function openEditModal(type, data) {
  if (!editModal || !editFieldsEl || !editTitleEl) return;
  editState = { type, id: data.id, postId: data.postId || null };
  if (type === "post") {
    editTitleEl.textContent = "Edit Post";
    editFieldsEl.innerHTML = `
      <div class="stack">
        <label for="edit-post-title">Post title</label>
        <input id="edit-post-title" name="title" type="text" required>
      </div>
      <div class="stack">
        <label for="edit-post-desc">Description (optional)</label>
        <textarea id="edit-post-desc" name="description" rows="3"></textarea>
      </div>
    `;
    editFieldsEl.querySelector("#edit-post-title").value = data.title || "";
    editFieldsEl.querySelector("#edit-post-desc").value = data.description || "";
  } else {
    editTitleEl.textContent = "Edit Candidate";
    editFieldsEl.innerHTML = `
      <div class="stack">
        <label for="edit-candidate-name">Candidate name</label>
        <input id="edit-candidate-name" name="name" type="text" required>
      </div>
    `;
    editFieldsEl.querySelector("#edit-candidate-name").value = data.name || "";
  }
  editModal.classList.remove("hidden");
  editModal.setAttribute("aria-hidden", "false");
  const first = editFieldsEl.querySelector("input, textarea");
  if (first) setTimeout(() => { first.focus(); first.select(); }, 0);
}

function closeEditModal() {
  if (!editModal) return;
  editModal.classList.add("hidden");
  editModal.setAttribute("aria-hidden", "true");
  editState = null;
  if (editForm) editForm.reset();
  if (editFieldsEl) editFieldsEl.innerHTML = "";
}

if (editCancelBtn) editCancelBtn.addEventListener("click", closeEditModal);
if (editModal) {
  editModal.addEventListener("click", (e) => {
    if (e.target === editModal) closeEditModal();
  });
}
if (editForm) {
  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!editState) return;
    const originalText = editSaveBtn ? editSaveBtn.textContent : "Save Changes";
    try {
      if (editSaveBtn) { editSaveBtn.disabled = true; editSaveBtn.textContent = "Saving..."; }
      if (editState.type === "post") {
        const title = (editFieldsEl.querySelector("#edit-post-title") || {}).value.trim();
        const description = (editFieldsEl.querySelector("#edit-post-desc") || {}).value.trim();
        if (!title) { setMessage("Post title is required.", "error"); return; }
        await updateDoc(doc(db, "posts", editState.id), { title, description });
        setMessage("Post updated.", "success");
      } else if (editState.type === "candidate") {
        const name = (editFieldsEl.querySelector("#edit-candidate-name") || {}).value.trim();
        if (!name) { setMessage("Candidate name is required.", "error"); return; }
        await updateDoc(doc(db, "candidates", editState.id), { name });
        setMessage("Candidate updated.", "success");
      }
      closeEditModal();
      await loadAll();
    } catch (err) {
      console.error(err);
      setMessage(`Failed to save changes: ${err.message}`, "error");
    } finally {
      if (editSaveBtn) { editSaveBtn.disabled = false; editSaveBtn.textContent = originalText; }
    }
  });
}

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
        if (isOfflineFirestoreError(err)) {
          sessionStorage.setItem("adminLoginError", `Admin check could not reach Firestore: ${err.message}. Check internet/ad blockers and ensure Cloud Firestore is enabled for this project. Clear site data if the problem persists.`);
        }
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
  if (!candidateInputsWrap || candidateInputsWrap.children.length === 0) {
    resetCandidateInputs();
  }

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
        <div class="post-actions">
          <span class="badge ${closed ? "closed" : ""}">${closed ? "Closed" : "Open"}</span>
          <button type="button" class="btn secondary small edit-post-btn">Edit</button>
          <button type="button" class="btn secondary small toggle-btn">${closed ? "Reopen" : "Close"}</button>
          <button type="button" class="btn danger small delete-post-btn">Delete</button>
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
          <div class="candidate-actions">
            <button type="button" class="btn secondary small edit-candidate-btn">Edit</button>
            <button type="button" class="btn danger small delete-candidate-btn">Remove</button>
          </div>
        `;
        const editBtn = row.querySelector(".edit-candidate-btn");
        if (editBtn) {
          editBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openEditModal("candidate", { id: c.id, name: c.name, postId: post.id });
          });
        }
        const removeBtn = row.querySelector(".delete-candidate-btn");
        if (removeBtn) {
          removeBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await removeCandidate(c.id, post.id);
          });
        }
        list.appendChild(row);
      });
    }

    const editPostBtn = card.querySelector(".edit-post-btn");
    if (editPostBtn) editPostBtn.addEventListener("click", () => openEditModal("post", post));
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
  const inputs = Array.from(candidateInputsWrap ? candidateInputsWrap.querySelectorAll(".candidate-name-input") : []);
  const names = inputs.map(i => i.value.trim()).filter(Boolean);
  if (!postId) {
    setMessage("Please select a post.", "error");
    return;
  }
  if (names.length === 0) {
    setMessage("Please enter at least one candidate name.", "error");
    return;
  }
  const originalText = addCandidatesSubmitBtn ? addCandidatesSubmitBtn.textContent : "Add All Candidates";
  try {
    if (addCandidatesSubmitBtn) { addCandidatesSubmitBtn.disabled = true; addCandidatesSubmitBtn.textContent = "Adding..."; }
    await Promise.all(names.map(name => addDoc(collection(db, "candidates"), {
      postId, name, votes: 0, createdAt: serverTimestamp()
    })));
    resetCandidateInputs();
    setMessage(`${names.length} candidate${names.length === 1 ? "" : "s"} added.`, "success");
    await loadAll();
  } catch (err) {
    console.error(err);
    setMessage(`Failed to add candidate(s): ${err.message}`, "error");
  } finally {
    if (addCandidatesSubmitBtn) { addCandidatesSubmitBtn.disabled = false; addCandidatesSubmitBtn.textContent = originalText; }
  }
});

function resetCandidateInputs() {
  if (!candidateInputsWrap) return;
  candidateInputsWrap.innerHTML = "";
  candidateInputsWrap.appendChild(createCandidateInputRow("", true));
}

function createCandidateInputRow(value = "", autofocus = false) {
  const row = document.createElement("div");
  row.className = "candidate-input-row";
  row.innerHTML = `
    <input class="candidate-name-input" name="candidateNames[]" type="text" placeholder="e.g. Jane Doe" aria-label="Candidate name" required>
    <button type="button" class="btn danger small remove-candidate-input" title="Remove" aria-label="Remove candidate field">&times;</button>
  `;
  const input = row.querySelector(".candidate-name-input");
  const removeBtn = row.querySelector(".remove-candidate-input");
  if (input) {
    input.value = value;
    if (autofocus) setTimeout(() => input.focus(), 0);
  }
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      const rows = candidateInputsWrap ? candidateInputsWrap.querySelectorAll(".candidate-input-row") : [];
      if (rows.length <= 1) {
        if (input) input.value = "";
        if (input) input.focus();
        return;
      }
      row.remove();
    });
  }
  return row;
}

if (addCandidateFieldBtn && candidateInputsWrap) {
  addCandidateFieldBtn.addEventListener("click", () => {
    candidateInputsWrap.appendChild(createCandidateInputRow("", true));
  });
}

if (candidatePostSelect) {
  candidatePostSelect.addEventListener("change", () => {
    // keep entered names when switching posts? reset for clarity per-post batching
    // resetCandidateInputs(); // optional; leaving names as-is so user can reassign consciously
  });
}

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
  const ok = await showConfirm(
    "Remove this candidate?\n\nVotes for them remain in records, but the candidate will be deleted from this post.",
    { title: "Remove Candidate", confirmText: "Remove", confirmClass: "btn danger" }
  );
  if (!ok) return;
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
  const ok = await showConfirm(
    "Delete this post and all its candidates?\n\nThis cannot be undone.",
    { title: "Delete Post", confirmText: "Delete Post", confirmClass: "btn danger" }
  );
  if (!ok) return;
  try {
    const candidates = candidatesByPost[postId] || [];
    await Promise.all(candidates.map(c => deleteDoc(doc(db, "candidates", c.id))));
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
  const ok = await showConfirm(
    "End voting for all posts and view winners?\n\nThis will close all open posts so no more votes can be cast.",
    { title: "End Voting", confirmText: "End Voting", confirmClass: "btn danger" }
  );
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
