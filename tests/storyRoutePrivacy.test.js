import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  getStoryFeed,
  getStories,
  viewStory,
} from "../worker/routes/stories.js";

const ownerId = new ObjectId();
const viewerId = new ObjectId();
const friendId = new ObjectId();

function createDb(stories, users) {
  return {
    collection(name) {
      if (name === "users") {
        return {
          async findOne({ _id }) {
            return users.find(
              user => String(user._id) === String(_id)
            ) || null;
          },
          find(query) {
            return {
              project() {
                return {
                  async toArray() {
                    const ids = query._id.$in.map(String);
                    return users.filter(
                      user => ids.includes(String(user._id))
                    );
                  },
                };
              },
            };
          },
        };
      }

      if (name === "stories") {
        return {
          find() {
            return {
              sort() {
                return this;
              },
              async toArray() {
                return stories.filter(
                  story => story.expiresAt > new Date()
                );
              },
            };
          },

          async findOne(filter) {
            return stories.find(story => {
              if (String(story._id) !== String(filter._id)) {
                return false;
              }
              if (
                filter.expiresAt &&
                !(story.expiresAt > filter.expiresAt.$gt - 1)
              ) {
                return false;
              }
              return true;
            }) || null;
          },

          async updateOne(filter, update) {
            const story = stories.find(
              item => String(item._id) === String(filter._id)
            );
            if (!story) return { modifiedCount: 0 };

            const existingViews = story.views || [];
            const excluded = filter.views?.$nin || [];

            if (
              excluded.some(id =>
                existingViews.some(
                  existing => String(existing) === String(id)
                )
              )
            ) {
              return { modifiedCount: 0 };
            }

            story.views = [...existingViews, update.$addToSet.views];
            for (const [key, value] of Object.entries(update.$inc || {})) {
              story[key] = (story[key] || 0) + value;
            }
            return { modifiedCount: 1 };
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };
}

function makeStory(visibility, options = {}) {
  return {
    _id: new ObjectId(),
    user: options.user || ownerId,
    visibility,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    views: [],
    reactions: [],
    replies: [],
    viewsCount: 0,
  };
}

function makeUsers(options = {}) {
  return [
    {
      _id: ownerId,
      name: "Story owner",
      isPrivate: options.ownerPrivate || false,
      friends: options.ownerFriends || [],
    },
    {
      _id: viewerId,
      name: "Viewer",
      friends: options.viewerFriends || [],
    },
    {
      _id: friendId,
      name: "Friend",
      friends: [],
    },
  ];
}

function makeRequest(path = "/api/stories") {
  return new Request(`https://example.test${path}`);
}

const authenticate = async () => viewerId;

test("Story feed excludes private and friends-only Stories from a non-friend", async () => {
  const publicStory = makeStory("public");
  const friendsStory = makeStory("friends");
  const privateStory = makeStory("private");
  const stories = [publicStory, friendsStory, privateStory];
  const db = createDb(stories, makeUsers());

  const response = await getStoryFeed(
    makeRequest("/api/stories/feed"),
    {},
    {
      authenticate,
      getDatabase: async () => db,
    }
  );

  assert.equal(response.status, 200);
  const result = await response.json();

  assert.deepEqual(
    result.map(story => String(story._id)),
    [String(publicStory._id)]
  );
});

test("Story list excludes Stories the viewer cannot access", async () => {
  const publicStory = makeStory("public");
  const friendsStory = makeStory("friends");
  const privateStory = makeStory("private");
  const db = createDb(
    [publicStory, friendsStory, privateStory],
    makeUsers()
  );

  const response = await getStories(
    makeRequest("/api/stories"),
    {},
    {
      authenticate,
      withFreshDatabase: async (_env, operation) => operation(db),
    }
  );

  assert.equal(response.status, 200);
  const result = await response.json();

  assert.deepEqual(
    result.map(story => String(story._id)),
    [String(publicStory._id)]
  );
});

test("Story feed allows a mutual friend to see friends-only Stories", async () => {
  const friendsStory = makeStory("friends");
  const db = createDb(
    [friendsStory],
    makeUsers({
      ownerFriends: [viewerId],
      viewerFriends: [ownerId],
    })
  );

  const response = await getStoryFeed(
    makeRequest("/api/stories/feed"),
    {},
    {
      authenticate,
      getDatabase: async () => db,
    }
  );

  assert.equal(response.status, 200);
  const result = await response.json();

  assert.equal(result.length, 1);
  assert.equal(String(result[0]._id), String(friendsStory._id));
});

test("viewStory denies an unauthorised viewer before recording a view", async () => {
  const privateStory = makeStory("private");
  const db = createDb([privateStory], makeUsers());

  let pointsAwarded = 0;
  let notificationsSent = 0;

  const response = await viewStory(
    makeRequest(`/api/stories/${privateStory._id}`),
    {},
    {
      authenticate,
      getDatabase: async () => db,
      addPoints: async () => {
        pointsAwarded++;
      },
      sendNotification: async () => {
        notificationsSent++;
      },
    }
  );

  assert.equal(response.status, 404);
  assert.equal(privateStory.viewsCount, 0);
  assert.equal(privateStory.views.length, 0);
  assert.equal(pointsAwarded, 0);
  assert.equal(notificationsSent, 0);
});

test("viewStory denies a one-sided friendship", async () => {
  const friendsStory = makeStory("friends");
  const db = createDb(
    [friendsStory],
    makeUsers({ ownerFriends: [viewerId] })
  );

  const response = await viewStory(
    makeRequest(`/api/stories/${friendsStory._id}`),
    {},
    {
      authenticate,
      getDatabase: async () => db,
    }
  );

  assert.equal(response.status, 404);
  assert.equal(friendsStory.viewsCount, 0);
});
