import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

let app, auth, db, configError = null;

try {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY") {
    throw new Error("Firebase is not configured. Update js/firebase-config.js with your project settings.");
  }
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
  });
} catch (err) {
  configError = err;
  console.error(err);
}

export { app, auth, db, configError };

export function showConfigWarning(target = document.body) {
  if (!configError) return false;
  const el = document.createElement("div");
  el.className = "message error";
  el.textContent = configError.message;
  const container = target.querySelector(".container") || target;
  container.prepend(el);
  return true;
}

export function isOfflineFirestoreError(err) {
  const msg = String(err && (err.message || err.code || err) || "").toLowerCase();
  return msg.includes("client is offline") || msg.includes("failed to get document because the client is offline") || msg.includes("unavailable") || msg.includes("network");
}
