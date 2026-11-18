import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createPostAccessChecker } from "../worker/utils/postAccess.js";

const ownerId = new ObjectId();
const viewerId = new ObjectId();
const otherId = new ObjectId();

function createDb(users) {
  return {
    collection(name) {
      assert.equal(name, "users");

      return {
        async findOne({ _id }) {
          return users.find(
            user => String(user._id) === String(_id)
          ) || null;
        },
      };
    },
  };
}

function createUsers(options = {}) {
  return [
    {
      _id: ownerId,
      isPrivate: options.ownerPrivate ?? false,
      friends: options.ownerFriends ?? [],
    },
    {
      _id: viewerId,
      friends: options.viewerFriends ?? [],
    },
    {
      _id: otherId,
      friends: [],
    },
  ];
}

async function checkStory(visibility, options = {}) {
  const db = createDb(createUsers(options));
  const access = createPostAccessChecker(db, viewerId);

  return access.canViewPost({
    _id: new ObjectId(),
    user: ownerId,
    visibility,
    isSharedPost: false,
  });
}

test("public Story on public account is accessible to everyone", async () => {
  assert.equal(await checkStory("public"), true);
});

test("friends-only Story denies a non-friend", async () => {
  assert.equal(await checkStory("friends"), false);
});

test("friends-only Story allows mutual friends", async () => {
  assert.equal(
    await checkStory("friends", {
      ownerFriends: [viewerId],
      viewerFriends: [ownerId],
    }),
    true
  );
});

test("one-sided friendship does not grant Story access", async () => {
  assert.equal(
    await checkStory("friends", {
      ownerFriends: [viewerId],
      viewerFriends: [],
    }),
    false
  );
});

test("private Story is accessible only to its owner", async () => {
  assert.equal(await checkStory("private"), false);
});

test("private account public Story denies a non-friend", async () => {
  assert.equal(
    await checkStory("public", {
      ownerPrivate: true,
    }),
    false
  );
});

test("private account public Story allows mutual friends", async () => {
  assert.equal(
    await checkStory("public", {
      ownerPrivate: true,
      ownerFriends: [viewerId],
      viewerFriends: [ownerId],
    }),
    true
  );
});

test("Story owner can access their private Story", async () => {
  const db = createDb(createUsers());
  const access = createPostAccessChecker(db, ownerId);

  assert.equal(
    await access.canViewPost({
      _id: new ObjectId(),
      user: ownerId,
      visibility: "private",
      isSharedPost: false,
    }),
    true
  );
});

test("legacy Story without visibility defaults to public", async () => {
  assert.equal(await checkStory(undefined), true);
});

function createStoryDb(users, story) {
  return {
    collection(name) {
      if (name === "users") {
        return {
          async findOne({ _id }) {
            return users.find(
              user => String(user._id) === String(_id)
            ) || null;
          },
        };
      }

      if (name === "stories") {
        return {
          async findOne({ _id, expiresAt }) {
            if (!story) return null;

            const idMatches =
              String(story._id) === String(_id);

            const isActive =
              story.expiresAt instanceof Date &&
              story.expiresAt > expiresAt.$gt;

            return idMatches && isActive ? story : null;
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };
}

async function checkSharedStory(visibility, options = {}) {
  const storyId = new ObjectId();

  const story = {
    _id: storyId,
    user: ownerId,
    visibility,
    expiresAt: options.expiresAt ||
      new Date(Date.now() + 60_000),
  };

  const db = createStoryDb(createUsers(options), story);
  const access = createPostAccessChecker(db, viewerId);

  return access.canViewPost({
    _id: new ObjectId(),
    user: viewerId,
    visibility: "public",
    isSharedPost: true,
    sharedFrom: storyId,
    sharedFromType: "story",
  });
}

test("shared Friends-only Story denies a non-friend", async () => {
  assert.equal(
    await checkSharedStory("friends"),
    false
  );
});

test("shared Friends-only Story allows mutual friends", async () => {
  assert.equal(
    await checkSharedStory("friends", {
      ownerFriends: [viewerId],
      viewerFriends: [ownerId],
    }),
    true
  );
});

test("shared Friends-only Story denies one-sided friendship", async () => {
  assert.equal(
    await checkSharedStory("friends", {
      ownerFriends: [viewerId],
      viewerFriends: [],
    }),
    false
  );
});

test("shared Private Story denies a non-owner", async () => {
  assert.equal(
    await checkSharedStory("private"),
    false
  );
});

test("shared Story on a private account denies a non-friend", async () => {
  assert.equal(
    await checkSharedStory("public", {
      ownerPrivate: true,
    }),
    false
  );
});

test("shared Story on a private account allows mutual friends", async () => {
  assert.equal(
    await checkSharedStory("public", {
      ownerPrivate: true,
      ownerFriends: [viewerId],
      viewerFriends: [ownerId],
    }),
    true
  );
});

test("expired Story cannot be accessed through its shared Post", async () => {
  assert.equal(
    await checkSharedStory("public", {
      expiresAt: new Date(Date.now() - 60_000),
    }),
    false
  );
});
