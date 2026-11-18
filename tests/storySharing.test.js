import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { shareStory } from "../worker/routes/stories.js";

const storyId = new ObjectId();
const ownerId = new ObjectId();
const future = new Date(Date.now() + 60 * 60 * 1000);

function createHarness(options = {}) {
  const viewerId = options.viewerId || ownerId;

  const story = {
    _id: storyId,
    user: ownerId,
    caption: "Test Story",
    media: [{ url: "https://example.com/story.jpg", key: "test-key" }],
    visibility: options.visibility || "public",
    expiresAt: options.expiresAt ?? future,
  };

  const state = {
    reservations: [],
    insertedPosts: [],
    statsUpdated: false,
    reservationFilter: null,
  };

  const stories = {
    async updateOne(filter, update) {
      if (update.$push?.shareReservations) {
        state.reservationFilter = filter;

        if (options.allowReservation === false) {
          return { modifiedCount: 0 };
        }

        state.reservations.push(update.$push.shareReservations);
        return { modifiedCount: 1 };
      }

      if (update.$pull?.shareReservations) {
        const token = update.$pull.shareReservations.token;
        state.reservations = state.reservations.filter(
          item => item.token !== token
        );
        return { modifiedCount: 1 };
      }

      if (update.$inc) {
        state.statsUpdated = true;
        return { modifiedCount: 1 };
      }

      return { modifiedCount: 1 };
    },

    async findOne(filter) {
      if (filter["shareReservations.token"]) {
        return state.reservations.length ? story : null;
      }

      if (filter.expiresAt) {
        return story;
      }

      return options.existingStory === undefined
        ? story
        : options.existingStory;
    },
  };

  const posts = {
    async insertOne(post) {
      if (options.failPostInsert) {
        throw new Error("Simulated Post insertion failure");
      }

      state.insertedPosts.push(post);
      return { insertedId: new ObjectId() };
    },
  };

  const users = {
    async findOne(filter) {
      const id = String(filter._id);

      if (id === String(ownerId)) {
        return {
          _id: ownerId,
          friends: options.areFriends ? [viewerId] : [],
          isPrivate: options.ownerIsPrivate === true,
        };
      }

      if (id === String(viewerId)) {
        return {
          _id: viewerId,
          friends: options.areFriends ? [ownerId] : [],
        };
      }

      return null;
    },
  };

  const db = {
    collection(name) {
      if (name === "stories") return stories;
      if (name === "posts") return posts;
      if (name === "users") return users;
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const dependencies = {
    authenticate: async () => viewerId.toString(),
    getDatabase: async () => db,
  };

  const request = new Request(
    `https://example.com/api/stories/share/${storyId.toString()}`,
    { method: "POST" }
  );

  return { request, dependencies, state };
}

test("shares an active Story and releases its reservation", async () => {
  const harness = createHarness();

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(harness.state.insertedPosts.length, 1);
  assert.equal(harness.state.statsUpdated, true);
  assert.equal(harness.state.reservations.length, 0);

  assert.ok(harness.state.reservationFilter.expiresAt.$gt);
  assert.ok(harness.state.reservationFilter.$or);
});


test("shared Post retains its original Story reference", async () => {
  const harness = createHarness();

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 200);

  const post = harness.state.insertedPosts[0];

  assert.equal(String(post.sharedFrom), String(storyId));
  assert.equal(post.sharedFromType, "story");
  assert.equal(post.isSharedPost, true);
  assert.equal(String(post.originalAuthor), String(ownerId));
});

test("blocks a non-friend from sharing a Friends-only Story", async () => {
  const viewerId = new ObjectId();

  const harness = createHarness({
    viewerId,
    visibility: "friends",
    areFriends: false,
  });

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 404);
  assert.equal(harness.state.insertedPosts.length, 0);
  assert.equal(harness.state.statsUpdated, false);
  assert.equal(harness.state.reservations.length, 0);
});

test("allows a mutual friend to share a Friends-only Story", async () => {
  const viewerId = new ObjectId();

  const harness = createHarness({
    viewerId,
    visibility: "friends",
    areFriends: true,
  });

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 200);
  assert.equal(harness.state.insertedPosts.length, 1);
  assert.equal(harness.state.insertedPosts[0].sharedFromType, "story");
  assert.equal(harness.state.reservations.length, 0);
});

test("rejects an expired Story", async () => {
  const harness = createHarness({
    allowReservation: false,
    expiresAt: new Date(Date.now() - 60_000),
  });

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 404);
  assert.equal(harness.state.insertedPosts.length, 0);
});

test("rejects a Story with an active cleanup lease", async () => {
  const harness = createHarness({
    allowReservation: false,
  });

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 409);
  assert.equal(harness.state.insertedPosts.length, 0);
});

test("rejects a legacy Story without an expiry date", async () => {
  const legacyStory = {
    _id: storyId,
    user: ownerId,
    caption: "Legacy Story",
    media: [],
  };

  const harness = createHarness({
    allowReservation: false,
    existingStory: legacyStory,
  });

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 404);
  assert.equal(harness.state.insertedPosts.length, 0);
});

test("releases the reservation if Post insertion fails", async () => {
  const harness = createHarness({
    failPostInsert: true,
  });

  const response = await shareStory(
    harness.request,
    {},
    harness.dependencies
  );

  assert.equal(response.status, 500);
  assert.equal(harness.state.reservations.length, 0);
  assert.equal(harness.state.insertedPosts.length, 0);
});

test("rejects an invalid Story ID before accessing the database", async () => {
  let databaseCalled = false;

  const response = await shareStory(
    new Request("https://example.com/api/stories/not-valid/share"),
    {},
    {
      authenticate: async () => ownerId.toString(),
      getDatabase: async () => {
        databaseCalled = true;
        throw new Error("Database should not be accessed");
      },
    }
  );

  assert.equal(response.status, 400);
  assert.equal(databaseCalled, false);
});
