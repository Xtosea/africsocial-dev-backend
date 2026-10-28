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
  // ACCOUNT DELETION REQUESTS
  // One request per user; support finding requests by status.
  // ------------------------------------------------------------
  await db.collection("account_deletion_requests").createIndex(
    { userId: 1 },
    {
      unique: true,
      name: "uniq_account_deletion_user",
    }
  );

  await db.collection("account_deletion_requests").createIndex(
    { status: 1, requestedAt: 1 },
    { name: "account_deletion_status_requested_at" }
  );

  return true;
}