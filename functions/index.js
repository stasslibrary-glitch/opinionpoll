const { onCall, HttpsError } =
  require("firebase-functions/v2/https");

const { initializeApp } =
  require("firebase-admin/app");

const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();

exports.castVote = onCall(async (request) => {
  // 1. Authenticate voter
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Please log in before voting."
    );
  }

  const uid = request.auth.uid;
  const { postId, candidateId } = request.data || {};

  if (
    typeof postId !== "string" ||
    typeof candidateId !== "string" ||
    !postId.trim() ||
    !candidateId.trim()
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid voting information."
    );
  }

  // 2. Check approved voter
  const voterRef = db.collection("voters").doc(uid);

  const postRef = db.collection("posts").doc(postId);
  const candidateRef = db.collection("candidates").doc(candidateId);

  // Deterministic ID prevents duplicate votes
  const voteRef = db.collection("votes").doc(`${uid}_${postId}`);

  try {
    await db.runTransaction(async (transaction) => {

      // Read all required documents before writing
      const voterSnap = await transaction.get(voterRef);
      const postSnap = await transaction.get(postRef);
      const candidateSnap = await transaction.get(candidateRef);
      const voteSnap = await transaction.get(voteRef);

      if (!voterSnap.exists || voterSnap.data().active !== true) {
        throw new HttpsError(
          "permission-denied",
          "You are not an approved voter."
        );
      }

      if (!postSnap.exists) {
        throw new HttpsError(
          "not-found",
          "Voting position not found."
        );
      }

      if (postSnap.data().status !== "open") {
        throw new HttpsError(
          "failed-precondition",
          "Voting for this position is closed."
        );
      }

      if (!candidateSnap.exists ||
          candidateSnap.data().postId !== postId) {
        throw new HttpsError(
          "invalid-argument",
          "Candidate does not belong to this position."
        );
      }

      if (voteSnap.exists) {
        throw new HttpsError(
          "already-exists",
          "You have already voted for this position."
        );
      }

      // Record the vote
      transaction.create(voteRef, {
        voterId: uid,
        postId: postId,
        candidateId: candidateId,
        createdAt: FieldValue.serverTimestamp()
      });

      // Update candidate tally
      transaction.update(candidateRef, {
        votes: FieldValue.increment(1)
      });

      // Update position tally
      transaction.update(postRef, {
        totalVotes: FieldValue.increment(1)
      });
    });

    return {
      success: true,
      message: "Your vote has been recorded successfully."
    };

  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    console.error("Vote submission failed:", error);

    throw new HttpsError(
      "internal",
      "Unable to record your vote. Please try again."
    );
  }
});
