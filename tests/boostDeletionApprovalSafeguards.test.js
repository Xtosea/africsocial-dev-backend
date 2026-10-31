import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import {
  approveBoost,
} from "../worker/utils/boosts.js";

const BOOST_ID = new ObjectId("650000000000000000000101");
const USER_ID = new ObjectId("650000000000000000000102");
const ADMIN_ID = new ObjectId("650000000000000000000103");

function makeDatabase(options = {}) {
  const calls = {
    boostReads: 0,
    paymentReads: 0,
    userReads: 0,
    deletionRequestReads: 0,
    boostUpdates: 0,
  };

  const boost = {
    _id: BOOST_ID,
    user: USER_ID,
    productId: "boost_starter",
    amount: 1000,
    currency: "NGN",
    status: "pending_approval",
    transactionReference: "BOOST-TEST-001",
    createdAt: new Date(),
  };

  const payment = {
    user: USER_ID,
    productId: "boost_starter",
    transactionReference: "BOOST-TEST-001",
    status: "paid",
    ...(options.paymentOverrides || {}),
  };

  const owner = {
    _id: USER_ID,
    deletionStatus: "",
    ...(options.ownerOverrides || {}),
  };

  const database = {
    collection(name) {
      if (name === "boosts") {
        return {
          async findOne() {
            calls.boostReads++;

            if (options.failBoostLookup) {
              throw new Error("Simulated Boost lookup failure");
            }

            return options.boostMissing ? null : boost;
          },

          async findOneAndUpdate(filter, update) {
            calls.boostUpdates++;

            if (options.failBoostUpdate) {
              throw new Error("Simulated Boost update failure");
            }

            if (options.updateReturnsNull) {
              return null;
            }

            return {
              ...boost,
              ...update.$set,
            };
          },
        };
      }

      if (name === "payments") {
        return {
          async findOne() {
            calls.paymentReads++;

            if (options.failPaymentLookup) {
              throw new Error("Simulated payment lookup failure");
            }

            return options.paymentMissing
              ? null
              : payment;
          },
        };
      }

      if (name === "users") {
        return {
          async findOne() {
            calls.userReads++;

            if (options.failUserLookup) {
              throw new Error("Simulated user lookup failure");
            }

            return options.ownerMissing ? null : owner;
          },
        };
      }

      if (name === "account_deletion_requests") {
        return {
          async findOne() {
            calls.deletionRequestReads++;

            if (options.failDeletionRequestLookup) {
              throw new Error(
                "Simulated deletion-request lookup failure"
              );
            }

            return options.deletionRequest || null;
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return { database, calls };
}

async function assertBlocked(options, message) {
  const { database, calls } = makeDatabase(options);

  await assert.rejects(
    approveBoost(database, BOOST_ID, ADMIN_ID),
    message
  );

  assert.equal(
    calls.boostUpdates,
    0,
    "Blocked approval must never update the Boost."
  );
}

test("approves a valid paid Boost when all safeguards pass", async () => {
  const { database, calls } = makeDatabase();

  const result = await approveBoost(
    database,
    BOOST_ID,
    ADMIN_ID
  );

  assert.equal(result.status, "active");
  assert.equal(result.id, BOOST_ID.toString());
  assert.equal(result.user, USER_ID.toString());
  assert.equal(result.approvedBy, ADMIN_ID.toString());
  assert.ok(result.startedAt instanceof Date);
  assert.ok(result.expiresAt instanceof Date);

  assert.equal(calls.paymentReads, 1);
  assert.equal(calls.userReads, 1);
  assert.equal(calls.deletionRequestReads, 1);
  assert.equal(calls.boostUpdates, 1);
});

test("blocks approval when the Boost record is missing", async () => {
  const { database, calls } = makeDatabase({
    boostMissing: true,
  });

  await assert.rejects(
    approveBoost(database, BOOST_ID, ADMIN_ID),
    /Boost not found/
  );

  assert.equal(calls.paymentReads, 0);
  assert.equal(calls.boostUpdates, 0);
});

test("blocks approval when the payment record is missing", async () => {
  await assertBlocked(
    { paymentMissing: true },
    /payment record was not found/
  );
});

test("blocks approval when payment is not paid", async () => {
  await assertBlocked(
    { paymentOverrides: { status: "pending" } },
    /payment verification failed/
  );
});

test("blocks approval when payment owner does not match", async () => {
  await assertBlocked(
    {
      paymentOverrides: {
        user: new ObjectId("650000000000000000000199"),
      },
    },
    /payment verification failed/
  );
});

test("blocks approval when payment product does not match", async () => {
  await assertBlocked(
    {
      paymentOverrides: {
        productId: "boost_growth",
      },
    },
    /payment verification failed/
  );
});

test("blocks account-deletion financial review flag", async () => {
  await assertBlocked(
    {
      paymentOverrides: {
        accountDeletionReviewRequired: true,
      },
    },
    /financial review/
  );
});

test("blocks pending account-deletion financial review status", async () => {
  await assertBlocked(
    {
      paymentOverrides: {
        accountDeletionReviewStatus: "pending",
      },
    },
    /financial review/
  );
});

test("blocks activation review flag", async () => {
  await assertBlocked(
    {
      paymentOverrides: {
        activationReviewRequired: true,
      },
    },
    /financial review/
  );
});

test("blocks pending activation review status", async () => {
  await assertBlocked(
    {
      paymentOverrides: {
        activationReviewStatus: "pending",
      },
    },
    /financial review/
  );
});

test("blocks approval when the account owner is missing", async () => {
  await assertBlocked(
    { ownerMissing: true },
    /account owner could not be found/
  );
});

for (const status of [
  "requested",
  "pending",
  "processing",
  "review_required",
]) {
  test(`blocks approval when owner deletionStatus is ${status}`, async () => {
    await assertBlocked(
      {
        ownerOverrides: {
          deletionStatus: status,
        },
      },
      /active deletion process/
    );
  });
}

test("blocks an unresolved account-deletion request", async () => {
  await assertBlocked(
    {
      deletionRequest: {
        userId: USER_ID,
        status: "pending",
      },
    },
    /unresolved deletion request/
  );
});

test("blocks an account-deletion request with an unknown status", async () => {
  await assertBlocked(
    {
      deletionRequest: {
        userId: USER_ID,
      },
    },
    /unresolved deletion request/
  );
});

test("allows approval when the deletion request is cancelled", async () => {
  const { database, calls } = makeDatabase({
    deletionRequest: {
      userId: USER_ID,
      status: "cancelled",
    },
  });

  const result = await approveBoost(
    database,
    BOOST_ID,
    ADMIN_ID
  );

  assert.equal(result.status, "active");
  assert.equal(calls.boostUpdates, 1);
});

test("blocks approval when payment lookup fails", async () => {
  await assert.rejects(
    approveBoost(
      makeDatabase({ failPaymentLookup: true }).database,
      BOOST_ID,
      ADMIN_ID
    ),
    /Simulated payment lookup failure/
  );
});

test("blocks approval when user lookup fails", async () => {
  await assert.rejects(
    approveBoost(
      makeDatabase({ failUserLookup: true }).database,
      BOOST_ID,
      ADMIN_ID
    ),
    /Simulated user lookup failure/
  );
});

test("blocks approval when deletion-request lookup fails", async () => {
  await assert.rejects(
    approveBoost(
      makeDatabase({
        failDeletionRequestLookup: true,
      }).database,
      BOOST_ID,
      ADMIN_ID
    ),
    /Simulated deletion-request lookup failure/
  );
});

test("blocks approval when Boost update returns no document", async () => {
  const { database, calls } = makeDatabase({
    updateReturnsNull: true,
  });

  await assert.rejects(
    approveBoost(database, BOOST_ID, ADMIN_ID),
    /Boost could not be approved/
  );

  assert.equal(calls.boostUpdates, 1);
});

test("blocks approval when the Boost lookup fails", async () => {
  const { database, calls } = makeDatabase({
    failBoostLookup: true,
  });

  await assert.rejects(
    approveBoost(database, BOOST_ID, ADMIN_ID),
    /Simulated Boost lookup failure/
  );

  assert.equal(calls.boostUpdates, 0);
});
