import test from "node:test";
import assert from "node:assert/strict";
import { signProtectedReelMediaUrl } from "../worker/utils/reelMediaAccess.js";
import { verifyMediaAccessToken } from "../worker/utils/mediaAccessToken.js";

const secret = "test-media-secret-with-at-least-32-characters";
const viewerId = "0123456789abcdef01234567";
const key =
  "reels/abcdef0123456789abcdef01/1234567890123-0123456789abcdef0123456789abcdef.mp4";

test("signs a protected relative Reel media URL", async () => {
  const original = `/api/media?key=${key}`;
  const result = await signProtectedReelMediaUrl(original, {
    viewerId,
    secret,
  });

  const url = new URL(result, "https://media.invalid");
  const token = url.searchParams.get("access_token");

  assert.equal(url.pathname, "/api/media");
  assert.equal(url.searchParams.get("key"), key);
  assert.ok(token);

  const verified = await verifyMediaAccessToken({
    token,
    secret,
    key,
  });

  assert.equal(verified.viewerId, viewerId);
});

test("signs an absolute Reel media URL and preserves other parameters", async () => {
  const original =
    `https://africsocial.com/api/media?key=${key}&download=1`;
  const result = await signProtectedReelMediaUrl(original, {
    viewerId,
    secret,
  });

  const url = new URL(result);

  assert.equal(url.origin, "https://africsocial.com");
  assert.equal(url.searchParams.get("download"), "1");
  assert.ok(url.searchParams.get("access_token"));
});

test("leaves non-media URLs unchanged", async () => {
  const values = [
    "https://cdn.example.com/video.mp4",
    `/api/posts/${viewerId}`,
    `/api/media?key=stories/${viewerId}/image.jpg`,
  ];

  for (const value of values) {
    assert.equal(
      await signProtectedReelMediaUrl(value, { viewerId, secret }),
      value
    );
  }
});

test("leaves URLs unchanged when viewer or secret is missing", async () => {
  const original = `/api/media?key=${key}`;

  assert.equal(
    await signProtectedReelMediaUrl(original, { secret }),
    original
  );

  assert.equal(
    await signProtectedReelMediaUrl(original, { viewerId }),
    original
  );
});

test("does not sign a URL containing an invalid Reel media key", async () => {
  const original = "/api/media?key=reels/not-a-valid-key.mp4";

  assert.equal(
    await signProtectedReelMediaUrl(original, { viewerId, secret }),
    original
  );
});

test("signs protected Reel voice-over audio URLs", async () => {
  for (const extension of ["m4a", "ogg", "mp3", "aac"]) {
    const audioKey =
      `reels/abcdef0123456789abcdef01/1234567890123-0123456789abcdef0123456789abcdef.${extension}`;

    const original = `/api/media?key=${audioKey}`;
    const result = await signProtectedReelMediaUrl(original, {
      viewerId,
      secret,
    });

    const url = new URL(result, "https://media.invalid");
    const token = url.searchParams.get("access_token");

    assert.ok(token, `Expected a signed URL for .${extension}`);

    const verified = await verifyMediaAccessToken({
      token,
      secret,
      key: audioKey,
    });

    assert.equal(verified.viewerId, viewerId);
  }
});
