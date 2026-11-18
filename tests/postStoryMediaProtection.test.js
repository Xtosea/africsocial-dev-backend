import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  createPost,
  editPost,
} from "../worker/routes/posts.js";

const ownerId = new ObjectId();
const postId = new ObjectId();

const storyKey =
  `stories/${ownerId.toString()}/1234567890123-0123456789abcdef0123456789abcdef.jpg`;

function makeRequest(body) {
  return new Request("https://example.com/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createDependencies(db) {
  return {
    authenticate: async () => ownerId,
    getDatabase: async () => db,
  };
}

test("createPost rejects Story media in an ordinary Post", async () => {
  let insertCalled = false;

  const db = {
    collection(name) {
      assert.equal(name, "posts");

      return {
        async insertOne() {
          insertCalled = true;
        },
      };
    },
  };

  const response = await createPost(
    makeRequest({
      content: "Ordinary post",
      media: [{ key: storyKey, url: "https://example.com/story.jpg" }],
    }),
    {},
    createDependencies(db)
  );

  assert.equal(response.status, 400);

  const result = await response.json();

  assert.match(result.error, /Story media must be shared/);
  assert.equal(insertCalled, false);
});

test("editPost rejects adding new Story media to an existing Post", async () => {
  let updateCalled = false;

  const storedPost = {
    _id: postId,
    user: ownerId,
    media: [{ url: "https://example.com/ordinary.jpg" }],
  };

  const db = {
    collection(name) {
      assert.equal(name, "posts");

      return {
        async findOne() {
          return storedPost;
        },

        async updateOne() {
          updateCalled = true;
          return { modifiedCount: 1 };
        },
      };
    },
  };

  const response = await editPost(
    makeRequest({
      media: [{ key: storyKey, url: "https://example.com/story.jpg" }],
    }),
    {},
    postId.toString(),
    createDependencies(db)
  );

  assert.equal(response.status, 400);

  const result = await response.json();

  assert.match(result.error, /New Story media must be shared/);
  assert.equal(updateCalled, false);
});

test("editPost allows retaining an existing Story media reference", async () => {
  let updateCalled = false;

  let storedPost = {
    _id: postId,
    user: ownerId,
    media: [{ key: storyKey, url: "https://example.com/story.jpg" }],
    comments: [],
    taggedFriends: [],
  };

  const db = {
    collection(name) {
      if (name === "posts") {
        return {
          async findOne() {
            return storedPost;
          },

          async updateOne(filter, update) {
            updateCalled = true;
            storedPost = {
              ...storedPost,
              ...update.$set,
            };

            return { modifiedCount: 1 };
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

  const response = await editPost(
    makeRequest({
      media: [{ key: storyKey, url: "https://example.com/story.jpg" }],
      content: "Updated caption",
    }),
    {},
    postId.toString(),
    createDependencies(db)
  );

  assert.equal(response.status, 200);

  const result = await response.json();

  assert.equal(result.success, true);
  assert.equal(updateCalled, true);
  assert.equal(storedPost.content, "Updated caption");
  assert.equal(storedPost.media[0].key, storyKey);
});
