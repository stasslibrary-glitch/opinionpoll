import { db, configError, showConfigWarning } from "./firebase.js";
import {
  collection, getDocs, query, where, doc, runTransaction, increment, serverTimestamp, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const postsContainer = document.getElementById("posts-container");
const globalMessage = document.getElementById("global-message");
const sessionStatus = document.getElementById("session-status");
const nextVoterBtn = document.getElementById("next-voter-btn");
const newBallotBtn = document.getElementById("new-ballot-btn");
const completionCard = document.getElementById("completion-card");
const newBallotModal = document.getElementById("new-ballot-modal");
const newBallotForm = document.getElementById("new-ballot-form");
const ballotPasswordInput = document.getElementById("ballot-password");
const ballotError = document.getElementById("ballot-error");
const cancelBallotBtn = document.getElementById("cancel-ballot-btn");

// Change this password for your polling station supervisors
const BALLOT_PASSWORD = "pd";

// Session-only state (persists across refresh for this tab; cleared on new ballot). No persistent device lock.
const BALLOT_VOTES_KEY = "ballot_voted_posts";
const sessionVoted = new Set();
let totalOpenPosts = 0;
let postsCache = [];
let completionPrompted = false;

function loadBallotState() {
  try {
    const raw = sessionStorage.getItem(BALLOT_VOTES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) arr.forEach(id => { if (id) sessionVoted.add(String(id)); });
  } catch (_) {}
}

function saveBallotState() {
  try {
    sessionStorage.setItem(BALLOT_VOTES_KEY, JSON.stringify(Array.from(sessionVoted)));
  } catch (_) {}
}

function clearBallotState() {
  sessionVoted.clear();
  try { sessionStorage.removeItem(BALLOT_VOTES_KEY); } catch (_) {}
}

function clearLegacyLocks() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("voted_")) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

function setMessage(text, type = "info") {
  if (!globalMessage) return;
  globalMessage.textContent = text;
  globalMessage.className = `message ${type}`;
  globalMessage.classList.toggle("hidden", !text);
}

function clearMessage() { setMessage("", "info"); }

function hasVoted(postId) { return sessionVoted.has(String(postId)); }
function markVoted(postId) { sessionVoted.add(String(postId)); saveBallotState(); }

function updateSessionUI() {
  const done = sessionVoted.size;
  if (sessionStatus) {
    sessionStatus.textContent = totalOpenPosts > 0
      ? `Voter progress: ${done} / ${totalOpenPosts} post(s) completed`
      : "No open posts available.";
  }
  const complete = totalOpenPosts > 0 && done >= totalOpenPosts;
  if (completionCard) completionCard.classList.toggle("hidden", !complete);
  if (nextVoterBtn) nextVoterBtn.classList.toggle("hidden", !complete);
  if (postsContainer) postsContainer.classList.toggle("session-complete", complete);
  if (complete) {
    setMessage("All votes for this voter have been recorded securely. Enter the password to start the next ballot.", "success");
    if (!completionPrompted) {
      completionPrompted = true;
      openNewBallotModal();
    }
  } else {
    completionPrompted = false;
  }
}

function openNewBallotModal() {
  if (!newBallotModal) return;
  const inProgress = sessionVoted.size > 0 && !(totalOpenPosts > 0 && sessionVoted.size >= totalOpenPosts);
  if (inProgress) {
    const ok = window.confirm("A ballot is in progress. Start a new ballot for the next voter?\n\nVotes already submitted are safely recorded, but this device session will be reset.");
    if (!ok) return;
  }
  if (ballotError) { ballotError.classList.add("hidden"); ballotError.textContent = ""; }
  if (ballotPasswordInput) ballotPasswordInput.value = "";
  newBallotModal.classList.remove("hidden");
  if (ballotPasswordInput) ballotPasswordInput.focus();
}

function closeNewBallotModal() {
  if (newBallotModal) newBallotModal.classList.add("hidden");
  if (ballotError) { ballotError.classList.add("hidden"); ballotError.textContent = ""; }
  if (ballotPasswordInput) ballotPasswordInput.value = "";
}

function startNewBallot() {
  clearBallotState();
  completionPrompted = false;
  if (completionCard) completionCard.classList.add("hidden");
  if (postsContainer) postsContainer.classList.remove("session-complete");
  clearMessage();
  renderAllPosts(postsCache, false);
  window.scrollTo({ top: 0, behavior: "smooth" });
  setMessage("New ballot ready. The next voter may now cast votes for each post.", "info");
}

function resetForNextVoter() {
  openNewBallotModal();
}

async function loadPostsAndCandidates() {
  if (!postsContainer) return;

  if (showConfigWarning(document) || !db) {
    postsContainer.innerHTML = `<div class="card"><p class="muted">Configure Firebase to enable voting. See <strong>README.md</strong>.</p></div>`;
    return;
  }

  try {
    const postsSnap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "asc")));
    if (postsSnap.empty) {
      postsContainer.innerHTML = `<div class="card"><h3>No posts yet</h3><p class="muted">The admin has not added any posts or candidates. Please check back later.</p></div>`;
      if (sessionStatus) sessionStatus.textContent = "No posts available.";
      return;
    }

    const postData = await Promise.all(postsSnap.docs.map(async (postDoc) => {
      const post = { id: postDoc.id, ...postDoc.data() };
      try {
        const candidatesSnap = await getDocs(query(collection(db, "candidates"), where("postId", "==", post.id)));
        const candidates = candidatesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        candidates.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        return { post, candidates, error: null };
      } catch (err) {
        console.error(err);
        return { post, candidates: [], error: err };
      }
    }));

    postsCache = postData;
    renderAllPosts(postData, true);
  } catch (err) {
    console.error(err);
    postsContainer.innerHTML = `<div class="card"><p class="message error">Failed to load posts: ${escapeHtml(err.message)}</p></div>`;
  }
}

function renderAllPosts(postData, announceErrors) {
  totalOpenPosts = postData.filter(p => p.post && p.post.status !== "closed").length;
  postsContainer.innerHTML = "";
  let hadCandidateError = false;
  postData.forEach(({ post, candidates, error }) => {
    if (error) hadCandidateError = true;
    postsContainer.appendChild(renderPost(post, candidates));
  });
  if (announceErrors && hadCandidateError) {
    setMessage("Some candidate lists could not load. Check Firestore rules/permissions or the browser console for details.", "error");
  } else if (!announceErrors) {
    updateSessionUI();
    return;
  }
  updateSessionUI();
}

function renderPost(post, candidates) {
  const card = document.createElement("section");
  card.className = "card post-card";
  const voted = hasVoted(post.id);
  const closed = post.status === "closed";

  card.innerHTML = `
    <div class="post-header">
      <div>
        <h2>${escapeHtml(post.title || "Untitled Post")}</h2>
        ${post.description ? `<p class="muted small">${escapeHtml(post.description)}</p>` : ""}
      </div>
      <span class="badge ${closed ? "closed" : ""}">${closed ? "Closed" : "Open"}</span>
    </div>
    <div class="candidates"></div>
    <p class="muted small status-note"></p>
  `;

  const list = card.querySelector(".candidates");
  const note = card.querySelector(".status-note");

  if (candidates.length === 0) {
    list.innerHTML = `<p class="muted">No candidates added for this post yet.</p>`;
  } else {
    candidates.forEach(c => {
      const row = document.createElement("div");
      row.className = "candidate";
      row.innerHTML = `
        <div class="candidate-info">
          <div class="candidate-name">${escapeHtml(c.name || "Unnamed")}</div>
        </div>
        <button class="btn vote-btn" ${voted || closed ? "disabled" : ""}>${voted ? "Voted" : "Vote"}</button>
      `;
      row.querySelector(".vote-btn").addEventListener("click", () => castVote(post, c, card));
      list.appendChild(row);
    });
  }

  if (closed) note.textContent = "Voting is closed for this post.";
  else if (voted) note.textContent = "Vote recorded for this post.";
  else note.textContent = "Choose one candidate for this post.";

  return card;
}

async function castVote(post, candidate, card) {
  clearMessage();
  if (hasVoted(post.id)) {
    setMessage("This post has already been voted for in this session.", "error");
    return;
  }
  if (post.status === "closed") {
    setMessage("Voting is closed for this post.", "error");
    return;
  }
  if (!db) return;

  const btns = card.querySelectorAll(".vote-btn");
  btns.forEach(b => { b.disabled = true; b.textContent = "Submitting..."; });

  try {
    console.log("[vote] starting transaction for post", post.id, "candidate", candidate.id);
    await runTransaction(db, async (transaction) => {
      const postRef = doc(db, "posts", post.id);
      const candidateRef = doc(db, "candidates", candidate.id);
      const postSnap = await transaction.get(postRef);
      if (!postSnap.exists()) throw new Error("Post not found.");
      if (postSnap.data().status === "closed") throw new Error("Voting is closed for this post.");

      transaction.update(candidateRef, { votes: increment(1) });
      const voteRef = doc(collection(db, "votes"));
      transaction.set(voteRef, {
        postId: post.id,
        candidateId: candidate.id,
        createdAt: serverTimestamp()
      });
    });
    console.log("[vote] transaction succeeded for post", post.id);

    markVoted(post.id);
    btns.forEach(b => { b.disabled = true; b.textContent = "Voted"; });
    card.querySelector(".status-note").textContent = `Vote recorded for ${candidate.name}.`;
    setMessage(`Vote recorded for "${candidate.name}".`, "success");
    updateSessionUI();
  } catch (err) {
    console.error("[vote] transaction failed:", err);
    const code = err.code ? ` (code: ${err.code})` : "";
    if (hasVoted(post.id)) {
      btns.forEach(b => { b.disabled = true; b.textContent = "Voted"; });
    } else {
      btns.forEach(b => { b.disabled = false; b.textContent = "Vote"; });
    }
    setMessage(`Could not record vote: ${err.message}${code}`, "error");
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

if (nextVoterBtn) nextVoterBtn.addEventListener("click", resetForNextVoter);
if (newBallotBtn) newBallotBtn.addEventListener("click", openNewBallotModal);

if (newBallotForm) {
  newBallotForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const entered = ballotPasswordInput ? ballotPasswordInput.value : "";
    if (entered === BALLOT_PASSWORD) {
      closeNewBallotModal();
      startNewBallot();
    } else {
      if (ballotError) {
        ballotError.textContent = "Incorrect password. New ballot not authorized.";
        ballotError.classList.remove("hidden");
      }
      if (ballotPasswordInput) {
        ballotPasswordInput.value = "";
        ballotPasswordInput.focus();
      }
    }
  });
}
if (cancelBallotBtn) cancelBallotBtn.addEventListener("click", closeNewBallotModal);
if (newBallotModal) {
  newBallotModal.addEventListener("click", (e) => {
    if (e.target && e.target.dataset && e.target.dataset.closeModal) closeNewBallotModal();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && newBallotModal && !newBallotModal.classList.contains("hidden")) closeNewBallotModal();
});

clearLegacyLocks();
loadBallotState();
loadPostsAndCandidates();

