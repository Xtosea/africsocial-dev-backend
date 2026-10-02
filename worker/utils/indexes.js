export async function ensureApplicationIndexes(db) {
  // ------------------------------------------------------------
  // KYC
  // One KYC record per seller.
  // ------------------------------------------------------------
  await db.collection("sellerkycs").createIndex(
    { user: 1 },
    { unique: true }
  );

  await db.collection("sellerkycs").createIndex(
    { status: 1, submittedAt: 1 }
  );

  // ------------------------------------------------------------
  // PREMIUM SUBSCRIPTIONS
  // Allows fast lookup of an active Premium subscription.
  // ------------------------------------------------------------
  await db.collection("subscriptions").createIndex(
    {
      user: 1,
      plan: 1,
      status: 1,
      expiresAt: 1,
    }
  );

  await db.collection("subscriptions").createIndex(
    { transactionReference: 1 },
    {
      unique: true,
      sparse: true,
    }
  );

  // ------------------------------------------------------------
  // PAYMENTS
  // One Paystack reference must only be processed once.
  // ------------------------------------------------------------
  await db.collection("payments").createIndex(
    { transactionReference: 1 },
    {
      unique: true,
      sparse: true,
    }
  );

  await db.collection("payments").createIndex(
    { user: 1, createdAt: -1 }
  );

  await db.collection("payments").createIndex(
    { status: 1, createdAt: -1 }
  );

  // ------------------------------------------------------------
  // BOOSTS
  // Fast lookup of active boosts for a post,
  // user boost history, and payment idempotency.
  // ------------------------------------------------------------
  await db.collection("boosts").createIndex(
    {
      post: 1,
      status: 1,
      expiresAt: 1,
    }
  );

  await db.collection("boosts").createIndex(
    {
      user: 1,
      createdAt: -1,
    }
  );

  await db.collection("boosts").createIndex(
    { transactionReference: 1 },
    {
      unique: true,
      sparse: true,
    }
  );

  // ------------------------------------------------------------
  // CREATOR QUALIFYING VIEWS
  // One qualifying view per viewer per content.
  // Fast rolling-period queries by creator and content.
  // ------------------------------------------------------------
  await db.collection("creator_qualifying_views").createIndex(
    {
      viewerId: 1,
      contentId: 1,
    },
    {
      unique: true,
    }
  );

  await db.collection("creator_qualifying_views").createIndex(
    {
      creatorId: 1,
      qualifiedAt: -1,
    }
  );

  await db.collection("creator_qualifying_views").createIndex(
    {
      contentId: 1,
      qualifiedAt: -1,
    }
  );

  return true;
}