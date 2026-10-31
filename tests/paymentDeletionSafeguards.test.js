import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

const USER_ID = new ObjectId("650000000000000000000002");
const REFERENCE = "AFS-TEST-DELETE-001";

let scenario;
let activationCalls;

mock.module(
  new URL("../worker/utils/auth.js", import.meta.url).href,
  {
    namedExports: {
      authenticate: async () => USER_ID,
    },
  },
);

mock.module(
  new URL("../worker/utils/paystack.js", import.meta.url).href,
  {
    namedExports: {
      initializePaystackTransaction: async () => ({}),
      verifyPaystackTransaction: async () => ({
        data: {
          status: "success",
          reference: REFERENCE,
          amount: 500000,
          currency: "NGN",
          id: 123456,
          channel: "card",
          paid_at: new Date().toISOString(),
        },
      }),
    },
  },
);

mock.module(
  new URL("../worker/utils/products.js", import.meta.url).href,
  {
    namedExports: {
      getProduct: () => ({}),
      getProductPrice: () => 5000,
    },
  },
);

mock.module(
  new URL("../worker/utils/premium.js", import.meta.url).href,
  {
    namedExports: {
      getActivePremiumSubscription: async () => null,
    },
  },
);

mock.module(
  new URL("../worker/utils/paymentActivation.js", import.meta.url).href,
  {
    namedExports: {
      activateVerifiedPayment: async () => {
        activationCalls += 1;
        return {
          activated: true,
          alreadyActivated: false,
          subscription: { _id: "subscription-test" },
        };
      },
    },
  },
);

mock.module(
  new URL("../worker/utils/advertisementActivation.js", import.meta.url).href,
  {
    namedExports: {
      activateVerifiedAdvertisement: async () => {
        activationCalls += 1;
        return {
          activated: true,
          alreadyActivated: false,
          campaign: { _id: "campaign-test" },
        };
      },
    },
  },
);

mock.module(
  new URL("../worker/utils/boosts.js", import.meta.url).href,
  {
    namedExports: {
      activateVerifiedBoost: async () => {
        activationCalls += 1;
        return {
          activated: true,
          alreadyActivated: false,
          boost: { _id: "boost-test" },
        };
      },
    },
  },
);

mock.module(
  new URL("../worker/utils/subscriptions.js", import.meta.url).href,
  {
    namedExports: {
      buildSubscriptionRecord: () => ({}),
    },
  },
);

const { verifyPaystackPayment } = await import(
  "../worker/routes/payments.js"
);

function makeDatabase() {
  const payment = {
    transactionReference: REFERENCE,
    user: USER_ID,
    status: "pending",
    gatewayStatus: "initialized",
    paystackAmount: 500000,
    amount: 5000,
    currency: "NGN",
    productId: "premium_monthly",
    productType: "premium",
  };

  return {
    collection(name) {
      if (name === "payments") {
        return {
          async findOne() {
            return payment;
          },

          async updateOne(filter, update) {
            scenario.paymentUpdates.push({ filter, update });

            if (
              scenario.failPaymentPaidUpdate &&
              update.$set?.status === "paid"
            ) {
              return { matchedCount: 0, modifiedCount: 0 };
            }

            if (
              scenario.failReviewUpdate &&
              update.$set?.accountDeletionReviewRequired
            ) {
              return { matchedCount: 0, modifiedCount: 0 };
            }

            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      }

      if (name === "users") {
        return {
          async findOne() {
            if (scenario.failUserLookup) {
              throw new Error("Simulated user lookup failure");
            }

            return {
              _id: USER_ID,
              deletionStatus: scenario.userDeletionStatus,
            };
          },
        };
      }

      if (name === "account_deletion_requests") {
        return {
          async findOne() {
            if (scenario.failDeletionRequestLookup) {
              throw new Error("Simulated deletion request lookup failure");
            }

            return scenario.deletionRequest;
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };
}

async function runVerification() {
  activationCalls = 0;

  const request = new Request(
    `https://test.local/api/payments/paystack/verify/${REFERENCE}`,
    {
      headers: {
        Authorization: "Bearer simulated-test-token",
      },
    },
  );

  const response = await verifyPaystackPayment(
    request,
    { JWT_SECRET: "test-only-secret" },
    makeDatabase(),
    REFERENCE,
  );

  return {
    status: response.status,
    body: await response.json(),
  };
}

function resetScenario(overrides = {}) {
  scenario = {
    userDeletionStatus: undefined,
    deletionRequest: null,
    failUserLookup: false,
    failDeletionRequestLookup: false,
    failPaymentPaidUpdate: false,
    failReviewUpdate: false,
    paymentUpdates: [],
    ...overrides,
  };
}

test("normal verified payment can activate its product", async () => {
  resetScenario();

  const { status, body } = await runVerification();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.verified, true);
  assert.equal(body.activated, true);
  assert.equal(activationCalls, 1);
});

test("pending deletion request blocks activation even when user status is missing", async () => {
  resetScenario({
    deletionRequest: {
      userId: USER_ID,
      status: "pending",
    },
  });

  const { status, body } = await runVerification();

  assert.equal(body.success, true);
  assert.equal(body.verified, true);
  assert.equal(body.activated, false);
  assert.equal(body.requiresReview, true);
  assert.equal(activationCalls, 0);
});

test("deletion request lookup failure prevents product activation", async () => {
  resetScenario({
    failDeletionRequestLookup: true,
  });

  const { body } = await runVerification();

  assert.equal(body.verified, true);
  assert.equal(body.activated, false);
  assert.equal(body.requiresReview, true);
  assert.equal(activationCalls, 0);
});

test("failed payment record update prevents product activation", async () => {
  resetScenario({
    failPaymentPaidUpdate: true,
  });

  const { body } = await runVerification();

  assert.equal(body.activated, false);
  assert.equal(activationCalls, 0);
});

test("failed financial review update never claims review was successfully recorded", async () => {
  resetScenario({
    userDeletionStatus: "pending",
    failReviewUpdate: true,
  });

  const { body } = await runVerification();

  assert.equal(body.verified, true);
  assert.equal(body.activated, false);
  assert.equal(activationCalls, 0);

  if (body.reviewRecorded !== undefined) {
    assert.notEqual(body.reviewRecorded, true);
  }

  if (body.message) {
    assert.doesNotMatch(
      body.message,
      /has been flagged for review/i,
    );
  }
});
