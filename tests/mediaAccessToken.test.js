import test from "node:test";
import assert from "node:assert/strict";
import {
  createMediaAccessToken,
  verifyMediaAccessToken,
} from "../worker/utils/mediaAccessToken.js";

const secret = "test-media-secret-that-is-at-least-32-characters-long";
const key = "reels/0123456789abcdef01234567/1234567890-abcdef0123456789abcdef01234567.mp4";
const viewerId = "0123456789abcdef01234567";

async function makeToken(overrides = {}) {
  return createMediaAccessToken({
    secret,
    key,
    viewerId,
    ...overrides,
  });
}

test("creates and verifies a token for its exact viewer and media key", async () => {
  const token = await makeToken();
  const result = await verifyMediaAccessToken({ token, secret, key });

  assert.equal(result.viewerId, viewerId);
  assert.ok(result.expiresAt > Math.floor(Date.now() / 1000));
});

test("rejects an expired token", async () => {
  const token = await makeToken();
  const result = await verifyMediaAccessToken({
    token,
    secret,
    key,
    nowSeconds: Math.floor(Date.now() / 1000) + 301,
  });

  assert.equal(result, null);
});

test("rejects a token used for a different media key", async () => {
  const token = await makeToken();
  const result = await verifyMediaAccessToken({
    token,
    secret,
    key: `${key}.different`,
  });

  assert.equal(result, null);
});

test("rejects a tampered token", async () => {
  const token = await makeToken();
  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  const result = await verifyMediaAccessToken({
    token: tampered,
    secret,
    key,
  });

  assert.equal(result, null);
});

test("rejects a token signed with a different secret", async () => {
  const token = await makeToken();
  const result = await verifyMediaAccessToken({
    token,
    secret: "another-media-secret-that-is-at-least-32-characters-long",
    key,
  });

  assert.equal(result, null);
});

test("rejects a signing secret that is too short", async () => {
  await assert.rejects(
    () => makeToken({ secret: "too-short" }),
    /signing secret is unavailable/
  );
});
