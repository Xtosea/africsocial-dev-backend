import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { ObjectId } from "mongodb";

import {
  getWallet,
  convertPoints,
  getTransactions,
  adminAdjustPoints,
} from "../worker/routes/wallet.js";

globalThis.crypto ??= webcrypto;

const JWT_SECRET = "wallet-deletion-test-secret-only";
const USER_ID = new ObjectId("650000000000000000000021");
const ADMIN_ID = new ObjectId("650000000000000000000022");
const TARGET_ID = new ObjectId("650000000000000000000023");

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function makeToken(id) {
  const header = base64url(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  );

  const payload = base64url(
    JSON.stringify({
      id: id.toString(),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  );

  const signingInput = `${header}.${payload}`;

  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await webcrypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(
    Buffer.from(signature),
  )}`;
}

const USER_TOKEN = await makeToken(USER_ID);
const ADMIN_TOKEN = await makeToken(ADMIN_ID);

function makeRequest(path, token, method = "GET", body) {
  const headers = {
    Authorization: `Bearer ${token}`,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return new Request(`https://test.local${path}`, {
    method,
    headers,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body) }),
  });
}

function makeDatabase({
  userDeletionStatus,
  targetDeletionStatus,
  deletionRequestStatus,
  failDeletionRequestLookup = false,
} = {}) {
  const calls = {
    walletReads: 0,
    walletWrites: 0,
    transactionReads: 0,
    deletionRequestReads: 0,
  };

  const user = {
    _id: USER_ID,
    role: "user",
    deletionStatus: userDeletionStatus,
  };

  const admin = {
    _id: ADMIN_ID,
    role: "admin",
  };

  const target = {
    _id: TARGET_ID,
    role: "user",
    deletionStatus: targetDeletionStatus,
  };

  const wallet = {
    user: USER_ID,
    balance: 0,
    points: 12000,
    lifetimeEarned: 0,
    pending: 0,
    storyLikes: 0,
    storyViews: 0,
    reelLikes: 0,
    reelViews: 0,
    videoLikes: 0,
    videoViews: 0,
    referralPoints: 0,
    leaderboardPoints: 0,
  };

  const database = {
    collection(name) {
      if (name === "users") {
        return {
          async findOne(filter) {
            if (filter._id?.toString() === ADMIN_ID.toString()) {
              return admin;
            }

            if (filter._id?.toString() === TARGET_ID.toString()) {
              return target;
            }

            if (filter._id?.toString() === USER_ID.toString()) {
              return user;
            }

            return null;
          },
        };
      }

      if (name === "account_deletion_requests") {
        return {
          async findOne() {
            calls.deletionRequestReads += 1;

            if (failDeletionRequestLookup) {
              throw new Error("Simulated deletion-request database failure");
            }

            if (!deletionRequestStatus) {
              return null;
            }

            return {
              userId: USER_ID,
              status: deletionRequestStatus,
            };
          },
        };
      }

      if (name === "wallets") {
        return {
          async findOne() {
            calls.walletReads += 1;
            return wallet;
          },

          async insertOne() {
            calls.walletWrites += 1;
            return { acknowledged: true };
          },

          async updateOne() {
            calls.walletWrites += 1;
            return { matchedCount: 1, modifiedCount: 1 };
          },

          async findOneAndUpdate() {
            calls.walletWrites += 1;
            return { balance: 0, points: 12000 };
          },
        };
      }

      if (name === "transactions") {
        return {
          find() {
            calls.transactionReads += 1;

            return {
              sort() {
                return this;
              },
              skip() {
                return this;
              },
              limit() {
                return this;
              },
              async toArray() {
                return [];
              },
            };
          },

          async countDocuments() {
            return 0;
          },
        };
      }

      throw new Error(`Unexpected database collection: ${name}`);
    },
  };

  return { database, calls };
}

const env = { JWT_SECRET };

test("getWallet blocks an account with deletion pending", async () => {
  const { database, calls } = makeDatabase({
    userDeletionStatus: "pending",
  });

  const response = await getWallet(
    makeRequest("/api/wallet", USER_TOKEN),
    env,
    database,
  );

  assert.equal(response.status, 403);

  const body = await response.json();
  assert.equal(body.code, "ACCOUNT_DELETION_PENDING");
  assert.equal(calls.walletReads, 0);
  assert.equal(calls.walletWrites, 0);
});

test("convertPoints blocks an account with deletion pending", async () => {
  const { database, calls } = makeDatabase({
    userDeletionStatus: "processing",
  });

  const response = await convertPoints(
    makeRequest(
      "/api/wallet/convert",
      USER_TOKEN,
      "POST",
      { currency: "NGN" },
    ),
    env,
    database,
  );

  assert.equal(response.status, 403);

  const body = await response.json();
  assert.equal(body.code, "ACCOUNT_DELETION_PENDING");
  assert.equal(calls.walletReads, 0);
  assert.equal(calls.walletWrites, 0);
});

test("getTransactions blocks an account with deletion pending", async () => {
  const { database, calls } = makeDatabase({
    userDeletionStatus: "review_required",
  });

  const response = await getTransactions(
    makeRequest("/api/wallet/transactions", USER_TOKEN),
    env,
    database,
  );

  assert.equal(response.status, 403);

  const body = await response.json();
  assert.equal(body.code, "ACCOUNT_DELETION_PENDING");
  assert.equal(calls.transactionReads, 0);
});

test("admin point adjustments block a target account with deletion pending", async () => {
  const { database, calls } = makeDatabase({
    targetDeletionStatus: "pending",
  });

  const response = await adminAdjustPoints(
    makeRequest(
      "/api/wallet/admin-adjust",
      ADMIN_TOKEN,
      "POST",
      {
        userId: TARGET_ID.toString(),
        action: "add",
        points: 100,
        reason: "Safeguard test",
      },
    ),
    env,
    database,
  );

  assert.equal(response.status, 409);

  const body = await response.json();
  assert.equal(body.code, "ACCOUNT_DELETION_PENDING");
  assert.equal(calls.walletWrites, 0);
});

test("a cancelled deletion request does not by itself block wallet access", async () => {
  const { database, calls } = makeDatabase({
    deletionRequestStatus: "cancelled",
  });

  const response = await getWallet(
    makeRequest("/api/wallet", USER_TOKEN),
    env,
    database,
  );

  assert.notEqual(response.status, 403);
  assert.equal(calls.deletionRequestReads, 1);
  assert.equal(calls.walletReads, 1);
});

test("a deletion-request database error fails closed for wallet access", async () => {
  const { database, calls } = makeDatabase({
    failDeletionRequestLookup: true,
  });

  const response = await getWallet(
    makeRequest("/api/wallet", USER_TOKEN),
    env,
    database,
  );

  assert.equal(response.status, 500);
  assert.equal(calls.walletReads, 0);
  assert.equal(calls.walletWrites, 0);
});
