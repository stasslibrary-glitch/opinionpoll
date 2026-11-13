import { auth, db, showConfigWarning, isOfflineFirestoreError } from "./firebase.js";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.getElementById("login-form");
const msg = document.getElementById("login-message");
const btn = document.getElementById("login-btn");

function setMessage(text, type = "info") {
  msg.textContent = text;
  msg.className = `message ${type}`;
  msg.classList.remove("hidden");
}

async function isAdmin(uid) {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists();
}

if (showConfigWarning(document)) {
  btn.disabled = true;
} else {
  const stored = sessionStorage.getItem("adminLoginError");
  if (stored) {
    sessionStorage.removeItem("adminLoginError");
    setMessage(stored, "error");
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
      if (await isAdmin(user.uid)) window.location.href = "admin.html";
    } catch (err) {
      console.error(err);
      if (isOfflineFirestoreError(err)) {
        setMessage(`Could not verify admin access: ${err.message}. Check internet/ad blockers and ensure Firestore is enabled.`, "error");
      }
    }
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!auth || !db) return;
  btn.disabled = true;
  setMessage("Signing in...", "info");

  const email = form.email.value.trim();
  const password = form.password.value;

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    try {
      const ok = await isAdmin(cred.user.uid);
      if (!ok) {
        await signOut(auth);
        setMessage(`Not authorized. Your UID is: ${cred.user.uid}. In Firestore create collection "admins" with a document whose ID is this UID.`, "error");
        btn.disabled = false;
        return;
      }
      setMessage("Login successful. Redirecting...", "success");
      window.location.href = "admin.html";
    } catch (checkErr) {
      console.error(checkErr);
      await signOut(auth);
      if (isOfflineFirestoreError(checkErr)) {
        setMessage(
          `Signed in (UID: ${cred.user.uid}) but Firestore is unreachable: ${checkErr.message}. Check your internet connection, disable ad blockers/VPN/firewall for this site, and confirm Cloud Firestore is enabled in the Firebase console for project "st-opinion-poll". If this persists, clear this site's browser data (IndexedDB/cache) and try again.`,
          "error"
        );
      } else {
        setMessage(`Signed in (UID: ${cred.user.uid}) but admin check failed: ${checkErr.message}. Verify Firestore rules are published and the admins/${cred.user.uid} document exists.`, "error");
      }
      btn.disabled = false;
    }
  } catch (err) {
    console.error(err);
    setMessage(`Login failed: ${err.message}`, "error");
    btn.disabled = false;
  }
});
