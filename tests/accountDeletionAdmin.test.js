import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

const ADMIN_ID = new ObjectId(
  "650000000000000000000001"
);
const USER_ID = new ObjectId(
  "650000000000000000000002"
);
const REQUEST_ID = "650000000000000000000003";

const freshScenario = () => ({
  accountDeletionStatus: "pending",
  accountLookupFailure: false,
  walletLookupFailure: false,
  missingRequest: false,
  invalidRequestOwner: false,
  wallet: {
    balance: 0,
    pending: 0,
    points: 0,
    lifetimeEarned: 0
  },
  pendingPayments: 0,
  pendingTransactions: 0,
  creatorEarnings: {
    pending: 0,
    approved: 0,
    paid: 0,
    rejected: 0
  },
  withdrawals: {
    pending: 0,
    approved: 0,
    paid: 0,
    rejected: 0,
    invalid: 0
  },
  failedLookups: [],
  failedCounts: [],
  requestLookupCount: 0,
  request: {
    _id: new ObjectId(REQUEST_ID),
    userId: USER_ID,
    status: "pending",
    requestedAt: new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000
    )
  }
});

let scenario = freshScenario();
let authenticatedId = ADMIN_ID;
let authenticationFailure = null;
let databaseFailure = null;

function buildDatabase() {
  return {
    collection(name) {
      return {
        async findOne(filter) {
          if (
            scenario.failedLookups.includes(name) &&
            !(name === "users" && String(filter?._id) === String(ADMIN_ID))
          ) {
            throw new Error("Simulated lookup failure");
          }

          if (name === "users") {
            const id = String(filter?._id);

            if (id === String(ADMIN_ID)) {
              return { role: "admin" };
            }

            if (id === String(USER_ID)) {
              if (scenario.accountLookupFailure) {
                throw new Error("Simulated account lookup failure");
              }

              return {
                deletionStatus: scenario.accountDeletionStatus
              };
            }

            return null;
          }

          if (name === "account_deletion_requests") {
            scenario.requestLookupCount += 1;
            if (scenario.missingRequest) {
              return null;
            }

            if (scenario.invalidRequestOwner) {
              return {
                ...scenario.request,
                userId: "invalid-owner-id"
              };
            }

            return scenario.request;
          }

          if (name === "wallets") {
            if (scenario.walletLookupFailure) {
              throw new Error("Simulated wallet lookup failure");
            }

            return scenario.wallet;
          }

          return null;
        },

        async countDocuments(filter = {}) {
          if (scenario.failedCounts.includes(name)) {
            throw new Error("Simulated count failure");
          }

          if (name === "withdrawals") {
            if (filter.status === "pending") return scenario.withdrawals.pending;
            if (filter.status === "approved") return scenario.withdrawals.approved;
            if (filter.status === "paid") return scenario.withdrawals.paid;
            if (filter.status === "rejected") return scenario.withdrawals.rejected;
            if (filter.$or) return scenario.withdrawals.invalid;
            return 0;
          }

          if (name === "payments") {
            return scenario.pendingPayments;
          }

          if (name === "transactions") {
            return scenario.pendingTransactions;
          }

          if (name === "creatorearnings") {
            return scenario.creatorEarnings[filter.status] ?? 0;
          }

          return 0;
        }
      };
    }
  };
}

mock.module(
  new URL("../worker/utils/auth.js", import.meta.url).href,
  {
    namedExports: {
      authenticate: async () => {
        if (authenticationFailure) {
          throw new Error(authenticationFailure);
        }
        return authenticatedId;
      }
    }
  }
);

mock.module(
  new URL("../worker/utils/db.js", import.meta.url).href,
  {
    namedExports: {
      getDatabase: async () => {
        if (databaseFailure) {
          throw new Error(databaseFailure);
        }
        return buildDatabase();
      }
    }
  }
);

const { previewAdminAccountDeletion } = await import(
  "../worker/routes/accountDeletionAdmin.js"
);

async function runPreview({ requestId = REQUEST_ID } = {}) {
  const request = new Request(
    `https://test.local/api/admin/account-deletions/preview?requestId=${requestId}`,
    {
      headers: {
        Authorization: "Bearer simulated-test-token"
      }
    }
  );

  const response = await previewAdminAccountDeletion(
    request,
    {
      JWT_SECRET: "test-only",
      MONGO_URI: "not-a-real-database"
    }
  );

  return {
    status: response.status,
    body: await response.json()
  };
}

test("preview remains read-only with zero wallet values", async () => {
  scenario = freshScenario();

  const { status, body } = await runPreview();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.actualDeletionPerformed, false);
  assert.equal(body.canProceed, false);
  assert.equal(body.financialReview.required, false);
  assert.equal(body.financialReview.walletBalance, 0);
  assert.equal(body.financialReview.payoutSystemVerified, false);
});

test("missing wallet requires financial review", async () => {
  scenario = freshScenario();
  scenario.wallet = null;

  const { status, body } = await runPreview();

  assert.equal(status, 200);
  assert.equal(body.financialReview.walletRecordFound, false);
  assert.equal(body.financialReview.checksAvailable, false);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
  assert.equal(body.actualDeletionPerformed, false);
});

test("outstanding wallet balance requires financial review", async () => {
  scenario = freshScenario();
  scenario.wallet.balance = 2500;

  const { body } = await runPreview();

  assert.equal(body.financialReview.walletBalance, 2500);
  assert.equal(body.financialReview.walletHasOutstandingValue, true);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
});

test("unresolved payments and transactions require review", async () => {
  scenario = freshScenario();
  scenario.pendingPayments = 2;
  scenario.pendingTransactions = 3;

  const { body } = await runPreview();

  assert.equal(body.financialReview.pendingPayments, 2);
  assert.equal(body.financialReview.pendingTransactions, 3);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
});

test("pending withdrawals require financial review", async () => {
  scenario = freshScenario();
  scenario.withdrawals.pending = 2;

  const { body } = await runPreview();

  assert.equal(body.financialReview.withdrawals.pending, 2);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
});

test("approved withdrawals require financial review", async () => {
  scenario = freshScenario();
  scenario.withdrawals.approved = 1;

  const { body } = await runPreview();

  assert.equal(body.financialReview.withdrawals.approved, 1);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
});

test("paid and rejected withdrawal counts are reported", async () => {
  scenario = freshScenario();
  scenario.withdrawals.paid = 3;
  scenario.withdrawals.rejected = 2;

  const { body } = await runPreview();

  assert.equal(body.financialReview.withdrawals.paid, 3);
  assert.equal(body.financialReview.withdrawals.rejected, 2);
  assert.equal(body.canProceed, false);
});

test("invalid withdrawal records require financial review", async () => {
  scenario = freshScenario();
  scenario.withdrawals.invalid = 1;

  const { body } = await runPreview();

  assert.equal(body.financialReview.withdrawals.invalid, 1);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
});

test("failed withdrawal checks are not treated as zero", async () => {
  scenario = freshScenario();
  scenario.failedCounts = ["withdrawals"];

  const { body } = await runPreview();

  assert.equal(body.checks.withdrawalPendingCheckAvailable, false);
  assert.equal(body.checks.withdrawalApprovedCheckAvailable, false);
  assert.equal(body.checks.withdrawalPaidCheckAvailable, false);
  assert.equal(body.checks.withdrawalRejectedCheckAvailable, false);
  assert.equal(body.checks.withdrawalInvalidCheckAvailable, false);
  assert.equal(body.financialReview.withdrawalChecksAvailable, false);
  assert.equal(body.financialReview.checksAvailable, false);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.checks.allRequiredQueriesAvailable, false);
  assert.equal(body.canProceed, false);
});

test("failed payment check is not treated as zero", async () => {
  scenario = freshScenario();
  scenario.failedCounts = ["payments"];

  const { body } = await runPreview();

  assert.equal(body.checks.paymentCheckAvailable, false);
  assert.equal(body.financialReview.checksAvailable, false);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.checks.allRequiredQueriesAvailable, false);
  assert.equal(body.canProceed, false);
});

test("deletion remains blocked even when other checks pass", async () => {
  scenario = freshScenario();

  const { body } = await runPreview();

  assert.equal(body.checks.payoutSystemVerified, false);
  assert.equal(body.canProceed, false);
  assert.equal(body.actualDeletionPerformed, false);
  assert.equal(body.eligibleForFurtherReview, false);
});

test("request within grace period remains ineligible", async () => {
  scenario = freshScenario();
  scenario.request.requestedAt = new Date(
    Date.now() - 5 * 24 * 60 * 60 * 1000
  );

  const { body } = await runPreview();

  assert.equal(body.request.gracePeriodExpired, false);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.canProceed, false);
  assert.equal(body.actualDeletionPerformed, false);
});

test("invalid request date blocks further review", async () => {
  scenario = freshScenario();
  scenario.request.requestedAt = new Date("invalid");

  const { body } = await runPreview();

  assert.equal(body.request.requestedAt, null);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.canProceed, false);
  assert.ok(
    body.blockers.some((item) => item.includes("request date"))
  );
});

test("future request date blocks further review", async () => {
  scenario = freshScenario();
  scenario.request.requestedAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000
  );

  const { body } = await runPreview();

  assert.equal(body.request.requestedAt, null);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.canProceed, false);
});

test("account and deletion request status mismatch blocks review", async () => {
  scenario = freshScenario();
  scenario.accountDeletionStatus = "processing";

  const { body } = await runPreview();

  assert.equal(body.checks.accountStatusMatches, false);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.canProceed, false);
  assert.ok(
    body.blockers.some((item) => item.includes("statuses do not match"))
  );
});

test("unavailable content count blocks further review", async () => {
  scenario = freshScenario();
  scenario.failedCounts = ["posts"];

  const { body } = await runPreview();

  assert.equal(body.checks.allRequiredQueriesAvailable, false);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.canProceed, false);
  assert.equal(body.actualDeletionPerformed, false);
});

test("missing deletion request returns 404", async () => {
  scenario = freshScenario();
  scenario.missingRequest = true;

  const { status, body } = await runPreview();

  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.match(body.message, /not found/i);
});

test("invalid request owner is rejected without deletion", async () => {
  scenario = freshScenario();
  scenario.invalidRequestOwner = true;

  const { status, body } = await runPreview();

  assert.equal(status, 200);
  assert.equal(body.dryRun, true);
  assert.equal(body.checks.requestOwnerValid, false);
  assert.equal(body.canProceed, false);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.actualDeletionPerformed, false);
});

test("failed account lookup blocks further review", async () => {
  scenario = freshScenario();
  scenario.accountLookupFailure = true;

  const { body } = await runPreview();

  assert.equal(body.checks.allRequiredQueriesAvailable, false);
  assert.equal(body.eligibleForFurtherReview, false);
  assert.equal(body.canProceed, false);
  assert.equal(body.actualDeletionPerformed, false);
  assert.ok(
    body.blockers.some((item) => item.includes("account lookup failed"))
  );
});

test("failed wallet lookup requires financial review", async () => {
  scenario = freshScenario();
  scenario.walletLookupFailure = true;

  const { body } = await runPreview();

  assert.equal(body.financialReview.walletRecordFound, false);
  assert.equal(body.financialReview.checksAvailable, false);
  assert.equal(body.financialReview.required, true);
  assert.equal(body.canProceed, false);
  assert.equal(body.actualDeletionPerformed, false);
});


test("non-admin cannot access the deletion preview", async () => {
  scenario = freshScenario();
  authenticatedId = USER_ID;

  try {
    const { status, body } = await runPreview();

    assert.equal(status, 403);
    assert.equal(body.success, false);
    assert.match(body.message, /admin access required/i);
    assert.equal(scenario.requestLookupCount, 0);
  } finally {
    authenticatedId = ADMIN_ID;
  }
});

test("malformed request IDs are rejected before request lookup", async () => {
  for (const requestId of [
    "",
    "123",
    "zzzzzzzzzzzzzzzzzzzzzzzz",
    "65000000000000000000000!"
  ]) {
    scenario = freshScenario();

    const { status, body } = await runPreview({ requestId });

    assert.equal(status, 400, `Expected HTTP 400 for ID: "${requestId}"`);
    assert.equal(body.success, false);
    assert.match(body.message, /valid deletion request ID/i);
    assert.equal(
      scenario.requestLookupCount,
      0,
      `Database request lookup should not run for ID: "${requestId}"`
    );
  }
});


test("authentication required errors return 401 without looking up deletion requests", async () => {
  for (const errorMessage of [
    "Authentication required",
    "Invalid token"
  ]) {
    scenario = freshScenario();
    authenticationFailure = errorMessage;

    try {
      const { status, body } = await runPreview();

      assert.equal(status, 401);
      assert.equal(body.success, false);
      assert.match(body.message, /sign in with a valid account/i);
      assert.doesNotMatch(body.message, new RegExp(errorMessage));
      assert.equal(scenario.requestLookupCount, 0);
    } finally {
      authenticationFailure = null;
    }
  }
});


test("database initialisation failure returns a generic 500 response", async () => {
  scenario = freshScenario();
  databaseFailure = "Simulated private database connection details";

  try {
    const { status, body } = await runPreview();

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(
      body.message,
      "Unable to generate the account deletion preview."
    );
    assert.doesNotMatch(
      JSON.stringify(body),
      /Simulated private database connection details/
    );
    assert.equal(scenario.requestLookupCount, 0);
  } finally {
    databaseFailure = null;
  }
});


test("pending creator earnings require financial review", async () => {
  scenario = freshScenario();
  scenario.creatorEarnings.pending = 2;

  const result = await runPreview();
  const review = result.body.financialReview;

  assert.equal(review.creatorEarnings.pending, 2);
  assert.equal(review.creatorEarnings.outstanding, 2);
  assert.equal(review.creatorEarningsChecksAvailable, true);
  assert.equal(review.required, true);
  assert.equal(result.body.canProceed, false);
  assert.equal(result.body.actualDeletionPerformed, false);
});

test("approved creator earnings require financial review", async () => {
  scenario = freshScenario();
  scenario.creatorEarnings.approved = 3;

  const result = await runPreview();
  const review = result.body.financialReview;

  assert.equal(review.creatorEarnings.approved, 3);
  assert.equal(review.creatorEarnings.outstanding, 3);
  assert.equal(review.required, true);
  assert.equal(result.body.canProceed, false);
});

test("paid and rejected creator earnings are not outstanding liabilities", async () => {
  scenario = freshScenario();
  scenario.creatorEarnings.paid = 4;
  scenario.creatorEarnings.rejected = 2;

  const result = await runPreview();
  const review = result.body.financialReview;

  assert.equal(review.creatorEarnings.paid, 4);
  assert.equal(review.creatorEarnings.rejected, 2);
  assert.equal(review.creatorEarnings.outstanding, 0);
  assert.equal(review.required, false);
  assert.equal(review.payoutSystemVerified, false);
  assert.equal(result.body.canProceed, false);
});

test("unavailable creator earnings checks require review and block proceeding", async () => {
  scenario = freshScenario();
  scenario.failedCounts.push("creatorearnings");

  const result = await runPreview();
  const review = result.body.financialReview;

  assert.equal(review.creatorEarningsChecksAvailable, false);
  assert.equal(review.creatorEarnings.outstanding, null);
  assert.equal(review.required, true);
  assert.equal(result.body.checks.allRequiredQueriesAvailable, false);
  assert.equal(result.body.canProceed, false);
});
