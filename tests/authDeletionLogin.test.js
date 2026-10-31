import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { login } from "../worker/routes/auth.js";

const PASSWORD = "TestPassword123!";
const PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
const USER_ID = new ObjectId("650000000000000000000002");

function makeRequest() {
  return new Request("https://test.local/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      identifier: "test@example.com",
      password: PASSWORD,
    }),
  });
}

function makeDatabase(
  deletionStatus,
  deletionRequestStatus = null,
  failDeletionRequestLookup = false,
) {
  const user = {
    _id: USER_ID,
    name: "Test User",
    email: "test@example.com",
    password: PASSWORD_HASH,
    role: "user",
    deletionStatus,
  };

  return {
    collection(name) {
      if (name === "users") {
        return {
          async findOne(filter) {
            assert.equal(filter.email, "test@example.com");
            return user;
          },
        };
      }

      if (name === "account_deletion_requests") {
        return {
          async findOne(filter) {
            assert.equal(filter.userId, USER_ID);

            if (failDeletionRequestLookup) {
              throw new Error(
                "Simulated deletion request lookup failure"
              );
            }

            return deletionRequestStatus
              ? {
                  userId: USER_ID,
                  status: deletionRequestStatus,
                }
              : null;
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };
}

for (const status of [
  "requested",
  "pending",
  "processing",
  "review_required",
]) {
  test(`login is blocked for deletion status: ${status}`, async () => {
    const response = await login(
      makeRequest(),
      { JWT_SECRET: "test-only-secret" },
      makeDatabase(status),
    );

    assert.equal(response.status, 403);

    const body = await response.json();

    assert.equal(
      body.message,
      "This account has a pending deletion request.",
    );
    assert.equal(body.token, undefined);
  });
}

test("login succeeds for an account without a deletion request", async () => {
  const response = await login(
    makeRequest(),
    { JWT_SECRET: "test-only-secret" },
    makeDatabase(undefined),
  );

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.message, "Login successful");
  assert.equal(typeof body.token, "string");
  assert.equal(body.user.email, "test@example.com");
});


test("login is blocked when an active deletion request exists without user deletion status", async () => {
  for (const status of ["pending", "processing", "review_required"]) {
    const response = await login(
      makeRequest(),
      { JWT_SECRET: "test-only-secret" },
      makeDatabase(undefined, status),
    );

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.token, undefined);
  }
});

test("login is allowed when the deletion request is cancelled", async () => {
  const response = await login(
    makeRequest(),
    { JWT_SECRET: "test-only-secret" },
    makeDatabase(undefined, "cancelled"),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.token, "string");
});

test("login fails closed when deletion request lookup fails", async () => {
  const response = await login(
    makeRequest(),
    { JWT_SECRET: "test-only-secret" },
    makeDatabase(undefined, null, true),
  );

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.token, undefined);
});
