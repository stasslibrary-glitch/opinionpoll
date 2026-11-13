# School Opinion Poll (Voting Site)

A simple school opinion/voting site built with **HTML, CSS, JavaScript**, and **Firebase** (Auth + Cloud Firestore). No build step required.

## Features
- **Voting page (`index.html`)**: Lists posts and candidates; users vote once per post per device/browser. Votes are counted in Firestore.
- **Results page (`results.html`)**: Shows live vote counts and percentages per candidate/post (refresh to update).
- **Admin login (`admin-login.html`)**: Email/password login for admins only.
- **Admin dashboard (`admin.html`)**: Add posts and candidates, open/close voting, delete posts/candidates, view vote totals and recent vote records.
- **Shared UI (`css/style.css`)** and Firebase modules (`js/`).

## File structure
```
index.html            # Public voting page
results.html          # Public results page
admin-login.html      # Admin login
admin.html            # Admin dashboard (protected)
css/style.css         # Shared styles
js/firebase-config.js # Your Firebase project config (edit this)
js/firebase.js        # Firebase init/helpers
js/vote.js            # Voting logic
js/results.js         # Results rendering
js/admin-login.js     # Admin auth
js/admin.js           # Admin management
README.md
```

## Firebase setup
1. Go to [Firebase Console](https://console.firebase.google.com/) and create a project.
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Authentication** → Users → add an admin user (email + password).
4. **Firestore Database** → Create database (production or test mode to start).
5. **Project settings** → General → Your apps → add a **Web app** and copy the config.
6. Paste the config into `js/firebase-config.js` (replace all `YOUR_*` values).
7. Create an **`admins`** collection in Firestore and add a document whose **Document ID is the admin user's UID** (from Authentication → Users). Example: `admins/<ADMIN_UID>` with any field, e.g. `{ "role": "admin" }`. Only users with a doc here can access the dashboard.

## Firestore data model
- **`posts`**: `{ title, description, status: "open"|"closed", totalVotes, createdAt }`
- **`candidates`**: `{ postId, name, votes, createdAt }`
- **`votes`**: `{ postId, candidateId, createdAt }` (record per vote)
- **`admins`**: doc ID = admin UID (presence grants admin access in the app)

## Suggested Firestore security rules (important)
Adjust as needed for your environment. These rules allow public reads/voting and restrict admin management to authenticated users listed in `admins`.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    match /admins/{uid} {
      allow read, write: if isAdmin();
    }

    match /posts/{postId} {
      allow read: if true;
      allow create, update, delete: if isAdmin();
    }

    match /candidates/{candidateId} {
      allow read: if true;
      allow create, delete: if isAdmin();
      // Allow public vote increments only (tighten further in production)
      allow update: if isAdmin() || (
        request.resource.data.diff(resource.data).affectedKeys().hasOnly(["votes"]) &&
        request.resource.data.votes == resource.data.votes + 1
      );
    }

    match /votes/{voteId} {
      allow read: if isAdmin();
      allow create: if true; // consider adding rate-limiting/app checks
      allow update, delete: if false;
    }
  }
}
```

> Note: Client-side checks (and per-device `localStorage`) limit casual repeat voting but cannot fully prevent determined duplicate votes without stronger identity (e.g. school accounts). For stricter elections, require authenticated voters and record voter IDs with rules to enforce one vote per user/post.

## Run locally
Because the app uses ES modules, serve it over HTTP (not `file://`):

- With VS Code Live Server, or
- `npx serve .` / `python -m http.server 8000` from this folder, then open `http://localhost:8000/index.html`

## Usage
1. Configure Firebase and create an admin user + `admins/<uid>` doc.
2. Open `admin-login.html`, sign in, and create posts/candidates.
3. Share `index.html` for voting and `results.html` for viewing results.
4. Close/reopen posts or remove entries from the dashboard as needed.
