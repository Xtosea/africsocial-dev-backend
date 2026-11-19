import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  createReelDuet,
  createReelRemix,
} from "../worker/routes/posts.js";

const creatorId = new ObjectId();
const viewerId = new ObjectId();
const reelId = new ObjectId();

function makeRequest(body = {}) {
  return new Request("https://example.com/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoUrl: "https://media.example.com/reused-reel.mp4",
      durationSeconds: 30,
      caption: "My new Reel",
      ...body,
    }),
  });
}

function makeDatabase({
  visibility = "public",
  allowDuet = false,
  allowRemix = false,
  creatorFriends = [],
  viewerFriends = [],
  viewerIsPrivate = false,
  sourceIsReel = true,
} = {}) {
  const original = {
    _id: reelId,
    user: creatorId,
    isReel: sourceIsReel,
    visibility,
    allowDuet,
    allowRemix,
  };

  const creator = {
    _id: creatorId,
    friends: creatorFriends,
  };

  const viewer = {
    _id: viewerId,
    friends: viewerFriends,
    isPrivate: viewerIsPrivate,
  };

  let insertedReel = null;

  const db = {
    collection(name) {
      if (name === "posts") {
        return {
          async findOne(query) {
            if (String(query._id) === String(reelId)) {
              if (query.isReel === true && !original.isReel) {
                return null;
              }
              return original;
            }
            return null;
          },

          async insertOne(reel) {
            insertedReel = { ...reel };
            return { insertedId: new ObjectId() };
          },
        };
      }

      if (name === "users") {
        return {
          async findOne(query) {
            if (String(query._id) === String(creatorId)) {
              return creator;
            }

            if (String(query._id) === String(viewerId)) {
              return viewer;
            }

            return null;
          },

          find() {
            return {
              project() {
                return {
                  async toArray() {
                    return [];
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return {
    db,
    original,
    getInsertedReel: () => insertedReel,
  };
}

function makeDependencies(mock, authenticatedUser = viewerId) {
  return {
    authenticate: async () => authenticatedUser,
    getDatabase: async () => mock.db,
  };
}

test("Duet and Remix permissions are independent", async () => {
  const duetMock = makeDatabase({
    allowDuet: false,
    allowRemix: true,
  });

  const duetResponse = await createReelDuet(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(duetMock)
  );

  assert.equal(duetResponse.status, 403);
  assert.equal(duetMock.getInsertedReel(), null);

  const remixMock = makeDatabase({
    allowDuet: true,
    allowRemix: false,
  });

  const remixResponse = await createReelRemix(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(remixMock)
  );

  assert.equal(remixResponse.status, 403);
  assert.equal(remixMock.getInsertedReel(), null);
});

test("Duet creates a Reel linked to its original source", async () => {
  const mock = makeDatabase({ allowDuet: true });

  const response = await createReelDuet(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(mock)
  );

  assert.equal(response.status, 201);

  const reel = mock.getInsertedReel();

  assert.ok(reel);
  assert.equal(reel.isReel, true);
  assert.equal(reel.reuseType, "duet");
  assert.equal(reel.isSharedPost, true);
  assert.equal(String(reel.sharedFrom), String(reelId));
  assert.equal(reel.sharedFromType, "reel");
  assert.equal(String(reel.originalAuthor), String(creatorId));
  assert.equal(reel.allowDuet, false);
  assert.equal(reel.allowRemix, false);
});

test("Remix works when Remix is enabled, independently of Duet", async () => {
  const mock = makeDatabase({
    allowDuet: false,
    allowRemix: true,
  });

  const response = await createReelRemix(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(mock)
  );

  assert.equal(response.status, 201);

  const reel = mock.getInsertedReel();

  assert.ok(reel);
  assert.equal(reel.reuseType, "remix");
  assert.equal(reel.isSharedPost, true);
  assert.equal(String(reel.sharedFrom), String(reelId));
});

test("Original creator can reuse their own Reel without enabling permission", async () => {
  for (const handler of [createReelDuet, createReelRemix]) {
    const mock = makeDatabase({
      allowDuet: false,
      allowRemix: false,
    });

    const response = await handler(
      makeRequest(),
      {},
      String(reelId),
      makeDependencies(mock, creatorId)
    );

    assert.equal(response.status, 201);
    assert.ok(mock.getInsertedReel());
  }
});

test("Private original Reel cannot be reused by another user", async () => {
  const mock = makeDatabase({
    visibility: "private",
    allowDuet: true,
    allowRemix: true,
  });

  const response = await createReelDuet(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(mock)
  );

  assert.equal(response.status, 404);
  assert.equal(mock.getInsertedReel(), null);
});

test("Friends-only original Reel cannot be reused by a non-friend", async () => {
  const mock = makeDatabase({
    visibility: "friends",
    allowDuet: true,
    allowRemix: true,
  });

  const response = await createReelRemix(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(mock)
  );

  assert.equal(response.status, 404);
  assert.equal(mock.getInsertedReel(), null);
});

test("Friends-only original Reel can be reused by an approved friend", async () => {
  const mock = makeDatabase({
    visibility: "friends",
    allowRemix: true,
    creatorFriends: [viewerId],
    viewerFriends: [creatorId],
  });

  const response = await createReelRemix(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(mock)
  );

  assert.equal(response.status, 201);
  assert.ok(mock.getInsertedReel());
});

test("Reuse rejects videos shorter than one second or longer than 60 seconds", async () => {
  for (const durationSeconds of [0.5, 61]) {
    const mock = makeDatabase({ allowDuet: true });

    const response = await createReelDuet(
      makeRequest({ durationSeconds }),
      {},
      String(reelId),
      makeDependencies(mock)
    );

    assert.equal(response.status, 400);
    assert.equal(mock.getInsertedReel(), null);
  }
});

test("Reuse rejects non-HTTPS video URLs", async () => {
  const mock = makeDatabase({ allowRemix: true });

  const response = await createReelRemix(
    makeRequest({
      videoUrl: "http://media.example.com/reused-reel.mp4",
    }),
    {},
    String(reelId),
    makeDependencies(mock)
  );

  assert.equal(response.status, 400);
  assert.equal(mock.getInsertedReel(), null);
});

test("Reuse rejects invalid IDs and non-Reel posts", async () => {
  const invalidIdMock = makeDatabase();

  const invalidResponse = await createReelDuet(
    makeRequest(),
    {},
    "not-a-valid-id",
    makeDependencies(invalidIdMock)
  );

  assert.equal(invalidResponse.status, 400);

  const postMock = makeDatabase({
    sourceIsReel: false,
    allowDuet: true,
  });

  const postResponse = await createReelDuet(
    makeRequest(),
    {},
    String(reelId),
    makeDependencies(postMock)
  );

  assert.equal(postResponse.status, 404);
  assert.equal(postMock.getInsertedReel(), null);
});
