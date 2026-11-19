import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { serveProtectedMedia } from "../worker/routes/protectedMedia.js";
import { createMediaAccessToken } from "../worker/utils/mediaAccessToken.js";

const ownerId = new ObjectId();
const viewerId = new ObjectId();

const reelKey =
  `reels/${ownerId}/1234567890123-0123456789abcdef0123456789abcdef.mp4`;

const storyThumbnailKey =
  `stories/${ownerId}/1234567890123-0123456789abcdef0123456789abcdef.jpg`;

function makeBucket() {
  const calls = { get: 0, head: 0 };

  return {
    calls,
    async head() {
      calls.head++;
      return {
        size: 100,
        httpEtag: '"test-etag"',
      };
    },
    async get() {
      calls.get++;
      return {
        size: 100,
        httpEtag: '"test-etag"',
        httpMetadata: { contentType: "video/mp4" },
        body: new Response("test-media").body,
      };
    },
  };
}

function makeDependencies({ posts = [], story = null, canView = true, authenticate = async () => viewerId } = {}) {
  const bucket = makeBucket();
  const accessViewerIds = [];

  const db = {
    collection(name) {
      if (name === "posts") {
        return {
          find() {
            return {
              limit() {
                return {
                  async toArray() {
                    return posts;
                  },
                };
              },
            };
          },
        };
      }

      if (name === "stories") {
        return {
          async findOne() {
            return story;
          },
        };
      }

      if (name === "users") {
        return {
          async findOne() {
            return { _id: ownerId, isPrivate: false };
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return {
    bucket,
    authenticate,
    accessViewerIds,
    getDatabase: async () => db,
    createPostAccessChecker: (_db, checkedViewerId) => {
      accessViewerIds.push(checkedViewerId);
      return { canViewPost: async () => canView };
    },
  };
}

function makeRequest(
  key,
  method = "GET",
  accessToken = null,
  download = false
) {
  const url = new URL("https://dev.example.com/api/media");
  url.searchParams.set("key", key);
  if (accessToken) url.searchParams.set("access_token", accessToken);
  if (download) url.searchParams.set("download", "1");
  return new Request(url, { method });
}

test("serves a public Reel through its protected media URL", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "public",
    isReel: true,
    media: [{
      url: `https://dev.example.com/api/media?key=${encodeURIComponent(reelKey)}`,
      type: "video",
    }],
  };

  const deps = makeDependencies({ posts: [post] });

  const response = await serveProtectedMedia(
    makeRequest(reelKey),
    {},
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.match(response.headers.get("Cache-Control"), /public/);
  assert.equal(deps.bucket.calls.get, 1);
});

test("denies a private Post when access is not granted", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "private",
    media: [{ key: reelKey }],
  };

  const deps = makeDependencies({
    posts: [post],
    canView: false,
  });

  const response = await serveProtectedMedia(
    makeRequest(reelKey),
    {},
    deps
  );

  assert.equal(response.status, 404);
  assert.equal(deps.bucket.calls.get, 0);
});

test("allows friends-only media when access is granted", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "friends",
    media: [{ key: reelKey }],
  };

  const deps = makeDependencies({
    posts: [post],
    canView: true,
  });

  const response = await serveProtectedMedia(
    makeRequest(reelKey),
    {},
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Cache-Control"),
    "private, no-store"
  );
});

test("denies friends-only media when access is not granted", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "friends",
    media: [{ key: reelKey }],
  };

  const deps = makeDependencies({
    posts: [post],
    canView: false,
  });

  const response = await serveProtectedMedia(
    makeRequest(reelKey),
    {},
    deps
  );

  assert.equal(response.status, 404);
  assert.equal(deps.bucket.calls.get, 0);
});

test("allows downloading a Reel when its creator enables downloads", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "public",
    isReel: true,
    allowDownload: true,
    media: [{ key: reelKey, type: "video" }],
  };

  const deps = makeDependencies({ posts: [post], canView: true });
  const response = await serveProtectedMedia(
    makeRequest(reelKey, "GET", null, true),
    {},
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(deps.bucket.calls.get, 1);
});

test("denies Reel downloads when the creator disables downloads", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "public",
    isReel: true,
    allowDownload: false,
    media: [{ key: reelKey, type: "video" }],
  };

  const deps = makeDependencies({ posts: [post], canView: true });
  const response = await serveProtectedMedia(
    makeRequest(reelKey, "GET", null, true),
    {},
    deps
  );

  assert.equal(response.status, 404);
  assert.equal(deps.bucket.calls.get, 0);
});

test("allows a Reel creator to download their own Reel", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "public",
    isReel: true,
    allowDownload: false,
    media: [{ key: reelKey, type: "video" }],
  };

  const deps = makeDependencies({
    posts: [post],
    canView: true,
    authenticate: async () => ownerId,
  });

  const response = await serveProtectedMedia(
    makeRequest(reelKey, "GET", null, true),
    {},
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(deps.bucket.calls.get, 1);
});

test("serves an authorised Story thumbnail", async () => {
  const story = {
    _id: new ObjectId(),
    user: ownerId,
    expiresAt: new Date(Date.now() + 60_000),
    media: [{
      thumbnailKey: storyThumbnailKey,
    }],
  };

  const deps = makeDependencies({ story });

  const response = await serveProtectedMedia(
    makeRequest(storyThumbnailKey),
    {},
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(deps.bucket.calls.get, 1);
});

test("denies an unauthorised Story thumbnail", async () => {
  const story = {
    _id: new ObjectId(),
    user: ownerId,
    expiresAt: new Date(Date.now() + 60_000),
    media: [{
      thumbnailKey: storyThumbnailKey,
    }],
  };

  const deps = makeDependencies({
    story,
    canView: false,
  });

  const response = await serveProtectedMedia(
    makeRequest(storyThumbnailKey),
    {},
    deps
  );

  assert.equal(response.status, 404);
  assert.equal(deps.bucket.calls.get, 0);
});

test("uses bucket HEAD without downloading the media body", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "public",
    media: [{ key: reelKey }],
  };

  const deps = makeDependencies({ posts: [post] });

  const response = await serveProtectedMedia(
    makeRequest(reelKey, "HEAD"),
    {},
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(deps.bucket.calls.head, 1);
  assert.equal(deps.bucket.calls.get, 0);
});


test("authorises friends-only media with a valid key-scoped access token", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "friends",
    media: [{ key: reelKey }],
  };
  const secret = "test-media-token-secret-that-is-at-least-32-characters";
  const token = await createMediaAccessToken({
    secret,
    key: reelKey,
    viewerId: String(viewerId),
  });
  const deps = makeDependencies({ posts: [post], canView: true, authenticate: async () => null });

  const response = await serveProtectedMedia(
    makeRequest(reelKey, "GET", token),
    { JWT_SECRET: secret },
    deps
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(deps.bucket.calls.get, 1);
  assert.equal(String(deps.accessViewerIds[0]), String(viewerId));
});

test("rejects a media access token issued for a different key", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "friends",
    media: [{ key: reelKey }],
  };
  const secret = "test-media-token-secret-that-is-at-least-32-characters";
  const token = await createMediaAccessToken({
    secret,
    key: `${reelKey}.different`,
    viewerId: String(viewerId),
  });
  const deps = makeDependencies({ posts: [post], canView: false, authenticate: async () => null });

  const response = await serveProtectedMedia(
    makeRequest(reelKey, "GET", token),
    { JWT_SECRET: secret },
    deps
  );

  assert.equal(response.status, 404);
  assert.equal(deps.accessViewerIds.length, 1);
  assert.equal(deps.accessViewerIds[0], null);
  assert.equal(deps.bucket.calls.get, 0);
});

test("rejects an invalid media access token without serving the object", async () => {
  const post = {
    _id: new ObjectId(),
    user: ownerId,
    visibility: "friends",
    media: [{ key: reelKey }],
  };
  const deps = makeDependencies({ posts: [post], canView: false, authenticate: async () => null });

  const response = await serveProtectedMedia(
    makeRequest(reelKey, "GET", "not-a-valid-token"),
    { JWT_SECRET: "test-media-token-secret-that-is-at-least-32-characters" },
    deps
  );

  assert.equal(response.status, 404);
  assert.equal(deps.accessViewerIds[0], null);
  assert.equal(deps.bucket.calls.get, 0);
});
