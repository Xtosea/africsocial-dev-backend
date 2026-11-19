import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createReel } from "../worker/routes/posts.js";

const ownerId = new ObjectId();

function makeRequest(body) {
  return new Request("https://example.com/api/posts/reels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDependencies() {
  let insertedReel = null;

  const db = {
    collection(name) {
      if (name === "posts") {
        return {
          async insertOne(reel) {
            insertedReel = { ...reel };
            return { insertedId: new ObjectId() };
          },
        };
      }

      if (name === "users") {
        return {
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
    dependencies: {
      authenticate: async () => ownerId,
      getDatabase: async () => db,
    },
    getInsertedReel: () => insertedReel,
  };
}

function validReel(overrides = {}) {
  return {
    caption: "Test Reel",
    videoUrl: "https://media.example.com/test-reel.mp4",
    durationSeconds: 30,
    ...overrides,
  };
}

test("createReel defaults to public with comments enabled and reuse/download disabled", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel()),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 201);

  const reel = mock.getInsertedReel();
  assert.ok(reel);
  assert.equal(reel.visibility, "public");
  assert.equal(reel.allowComments, true);
  assert.equal(reel.allowDuet, false);
  assert.equal(reel.allowRemix, false);
  assert.equal(reel.allowDownload, false);
  assert.equal(reel.isReel, true);
});

test("createReel saves each permission independently", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel({
      allowComments: false,
      allowDuet: true,
      allowRemix: false,
      allowDownload: true,
      visibility: "friends",
    })),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 201);

  const reel = mock.getInsertedReel();
  assert.equal(reel.visibility, "friends");
  assert.equal(reel.allowComments, false);
  assert.equal(reel.allowDuet, true);
  assert.equal(reel.allowRemix, false);
  assert.equal(reel.allowDownload, true);
});

test("createReel rejects videos shorter than one second", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel({ durationSeconds: 0.5 })),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /at least 1 second/);
  assert.equal(mock.getInsertedReel(), null);
});

test("createReel rejects videos longer than 60 seconds", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel({ durationSeconds: 61 })),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot exceed 60 seconds/);
  assert.equal(mock.getInsertedReel(), null);
});

test("createReel accepts videos at the one-second and 60-second limits", async () => {
  for (const durationSeconds of [1, 60]) {
    const mock = makeDependencies();

    const response = await createReel(
      makeRequest(validReel({ durationSeconds })),
      {},
      mock.dependencies
    );

    assert.equal(response.status, 201);
    assert.equal(mock.getInsertedReel().durationSeconds, durationSeconds);
  }
});

test("createReel rejects invalid visibility", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel({ visibility: "everyone" })),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 400);
  assert.equal(mock.getInsertedReel(), null);
});

test("createReel saves and sanitises editor metadata", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel({
      location: "  Lagos, Nigeria  ",
      taggedFriends: ["Alice", "Bob", 123, ""],
      tags: ["AfriSocial", "Reels", 123],
      editor: {
        text: "My Reel title",
        textPosition: { x: 120, y: 850 },
        textRotation: 15,
        textSize: 42,
        textColor: "#12ABEF",
        backgroundColor: "#123456",
      },
    })),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 201);

  const reel = mock.getInsertedReel();

  assert.equal(reel.location, "Lagos, Nigeria");
  assert.deepEqual(reel.taggedFriends, ["Alice", "Bob"]);
  assert.deepEqual(reel.tags, ["AfriSocial", "Reels"]);

  assert.deepEqual(reel.editor, {
    text: "My Reel title",
    textPosition: { x: 120, y: 850 },
    textRotation: 15,
    textSize: 42,
    textColor: "#12ABEF",
    backgroundColor: "#123456",
  });
});

test("createReel saves voice-over and sanitises video adjustments", async () => {
  const mock = makeDependencies();

  const response = await createReel(
    makeRequest(validReel({
      voiceOver: {
        audioUrl: "https://media.example.com/voiceover.webm",
        contentType: "audio/webm;codecs=opus",
        durationSeconds: 12,
        volume: 1.5,
      },
      videoAdjustments: {
        brightness: 2,
        contrast: 0.7,
        saturation: 3,
        sepia: 0.4,
      },
    })),
    {},
    mock.dependencies
  );

  assert.equal(response.status, 201);

  const reel = mock.getInsertedReel();

  assert.deepEqual(reel.voiceOver, {
    audioUrl: "https://media.example.com/voiceover.webm",
    contentType: "audio/webm",
    durationSeconds: 12,
    volume: 1,
  });

  assert.deepEqual(reel.videoAdjustments, {
    brightness: 1.5,
    contrast: 0.7,
    saturation: 2,
    sepia: 0.4,
  });
});
