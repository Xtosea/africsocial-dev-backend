import test from "node:test";
import assert from "node:assert/strict";
import { cleanupExpiredStories } from "../worker/utils/storyCleanup.js";

const OWNER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbbbbbbbbbbbbbbbbbb";

function mediaKey(owner = OWNER, filename = "1234567890123") {
  return `stories/${owner}/${filename}-0123456789abcdef0123456789abcdef.mp4`;
}

function getValues(object, path) {
  const parts = path.split(".");
  let values = [object];

  for (const part of parts) {
    values = values.flatMap((value) => {
      if (Array.isArray(value)) {
        return value.map((item) => item?.[part]);
      }
      return [value?.[part]];
    });
  }

  return values;
}

function conditionMatches(value, condition) {
  if (condition instanceof RegExp) {
    return typeof value === "string" && condition.test(value);
  }

  if (
    condition &&
    typeof condition === "object" &&
    !Array.isArray(condition) &&
    Object.keys(condition).some((key) => key.startsWith("$"))
  ) {
    for (const [operator, expected] of Object.entries(condition)) {
      if (operator === "$lte" && !(value instanceof Date ? value <= expected : value <= expected)) {
        return false;
      }

      if (operator === "$gt" && !(value instanceof Date ? value > expected : value > expected)) {
        return false;
      }

      if (operator === "$exists" && (value !== undefined) !== expected) {
        return false;
      }

      if (operator === "$not") {
        if (expected.$elemMatch && Array.isArray(value)) {
          if (value.some((item) => matchesFilter(item, expected.$elemMatch))) {
            return false;
          }
        }
      }
    }

    return true;
  }

  return value === condition;
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(([path, condition]) => {
    if (path === "$or") {
      return condition.some((item) => matchesFilter(document, item));
    }

    if (path === "_id" && condition?.$ne !== undefined) {
      return String(document._id) !== String(condition.$ne);
    }

    const values = getValues(document, path);

    if (path.startsWith("media.")) {
      return values.some((value) => conditionMatches(value, condition));
    }

    return conditionMatches(values[0], condition);
  });
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let current = object;

  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }

  current[parts.at(-1)] = value;
}

function unsetPath(object, path) {
  const parts = path.split(".");
  let current = object;

  for (const part of parts.slice(0, -1)) {
    current = current?.[part];
    if (!current) return;
  }

  delete current[parts.at(-1)];
}

function createHarness(initialStories, options = {}) {
  const stories = [...initialStories];
  const posts = [...(options.posts || [])];
  const deletedKeys = [];

  const collections = {
    stories,
    posts,
  };

  function collection(name) {
    const documents = collections[name];

    return {
      find(filter) {
        let results = documents.filter((document) =>
          matchesFilter(document, filter)
        );

        return {
          sort(sortOptions) {
            const field = Object.keys(sortOptions)[0];
            const direction = sortOptions[field];

            results = [...results].sort(
              (a, b) =>
                (a[field]?.getTime?.() || 0) -
                (b[field]?.getTime?.() || 0) * direction
            );

            return this;
          },

          limit(count) {
            results = results.slice(0, count);
            return this;
          },

          async toArray() {
            return results;
          },
        };
      },

      async findOne(filter) {
        return documents.find((document) =>
          matchesFilter(document, filter)
        ) ?? null;
      },

      async updateOne(filter, update) {
        const document = documents.find((item) =>
          matchesFilter(item, filter)
        );

        if (!document) {
          return { matchedCount: 0, modifiedCount: 0 };
        }

        for (const [path, value] of Object.entries(update.$set || {})) {
          setPath(document, path, value);
        }

        for (const path of Object.keys(update.$unset || {})) {
          unsetPath(document, path);
        }

        return { matchedCount: 1, modifiedCount: 1 };
      },

      async deleteOne(filter) {
        const index = documents.findIndex((document) =>
          matchesFilter(document, filter)
        );

        if (index === -1) {
          return { deletedCount: 0 };
        }

        documents.splice(index, 1);
        return { deletedCount: 1 };
      },
    };
  }

  const env = {
    MEDIA_BUCKET: {
      async delete(key) {
        if (options.failDelete) {
          throw new Error("Simulated R2 deletion failure");
        }

        deletedKeys.push(key);
      },
    },
  };

  const databaseRunner = async (_env, callback) =>
    callback({
      collection,
    });

  return {
    env,
    stories,
    posts,
    deletedKeys,
    databaseRunner,
  };
}

function expiredStory(id, media, user = OWNER, extra = {}) {
  return {
    _id: id,
    user,
    media,
    expiresAt: new Date(Date.now() - 60_000),
    ...extra,
  };
}

test("deletes expired Story media and its MongoDB record", async () => {
  const key = mediaKey();
  const harness = createHarness([
    expiredStory("story-1", [{ key }]),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, [key]);
  assert.equal(harness.stories.length, 0);
  assert.equal(result.deletedObjects, 1);
  assert.equal(result.deletedStories, 1);
  assert.equal(result.failedStories, 0);
});

test("deletes expired text or Cloudinary-only Stories without deleting R2 objects", async () => {
  const harness = createHarness([
    expiredStory("story-2", [
      { url: "https://example.com/image.jpg" },
    ]),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(harness.stories.length, 0);
  assert.equal(result.deletedStories, 1);
});

test("protects an R2 object referenced by another Story", async () => {
  const key = mediaKey();

  const harness = createHarness([
    expiredStory("story-3", [{ key }]),
    {
      _id: "story-4",
      user: OWNER,
      media: [{ key }],
    },
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(harness.stories.length, 1);
  assert.equal(harness.stories[0]._id, "story-4");
  assert.equal(result.protectedObjects, 1);
  assert.equal(result.deletedStories, 1);
});

test("protects objects referenced by legacy Stories without expiresAt", async () => {
  const key = mediaKey();

  const harness = createHarness([
    expiredStory("story-5", [{ key }]),
    {
      _id: "legacy-story",
      user: OWNER,
      media: [{ key }],
    },
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(result.protectedObjects, 1);
});

test("protects an object referenced by a legacy Story media URL", async () => {
  const key = mediaKey();
  const harness = createHarness([
    expiredStory("story-url-source", [{ key }]),
    {
      _id: "legacy-story-url",
      user: OWNER,
      media: [{ url: `https://media.example.com/api/media?key=${encodeURIComponent(key)}` }],
    },
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(result.protectedObjects, 1);
});

test("deletes expired Story thumbnails from R2", async () => {
  const key = mediaKey().replace(".mp4", ".jpg");
  const harness = createHarness([
    expiredStory("story-thumbnail-delete", [{ thumbnailKey: key }]),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, [key]);
  assert.equal(result.deletedObjects, 1);
  assert.equal(result.deletedStories, 1);
});

test("protects a thumbnail referenced by another Story", async () => {
  const thumbnailKey = mediaKey().replace(".mp4", ".jpg");

  const harness = createHarness([
    expiredStory("story-thumbnail-source", [{ thumbnailKey }]),
    {
      _id: "story-thumbnail-reference",
      user: OWNER,
      media: [{ thumbnailKey }],
    },
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(result.protectedObjects, 1);
  assert.equal(harness.stories.length, 1);
});

test("protects a thumbnail referenced by a Post", async () => {
  const thumbnailKey = mediaKey().replace(".mp4", ".jpg");

  const harness = createHarness(
    [expiredStory("story-thumbnail-post", [{ thumbnailKey }])],
    {
      posts: [
        {
          _id: "post-thumbnail-reference",
          media: [{ thumbnailKey }],
        },
      ],
    }
  );

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(result.protectedObjects, 1);
});

test("protects an object referenced by a Post thumbnail URL", async () => {
  const key = mediaKey();
  const harness = createHarness(
    [expiredStory("story-post-thumbnail-url", [{ key }])],
    {
      posts: [
        {
          _id: "post-thumbnail-url-reference",
          media: [{ thumbnailUrl: `https://media.example.com/${key}` }],
        },
      ],
    }
  );

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(result.protectedObjects, 1);
});

test("protects media referenced by an ordinary or shared Post", async () => {
  const key = mediaKey();

  const harness = createHarness(
    [expiredStory("story-post", [{ key }])],
    {
      posts: [
        {
          _id: "post-1",
          media: [{ key }],
        },
      ],
    }
  );

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(harness.stories.length, 0);
  assert.equal(result.protectedObjects, 1);
  assert.equal(result.deletedStories, 1);
});

test("does not claim a Story with an active sharing reservation", async () => {
  const key = mediaKey();

  const harness = createHarness([
    expiredStory("story-sharing", [{ key }], OWNER, {
      shareReservations: [
        {
          token: "active-share",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    }),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(harness.stories.length, 1);
  assert.equal(result.skippedStories, 1);
  assert.equal(result.claimedStories, 0);
});

test("does not claim a Story with an active cleanup lease", async () => {
  const key = mediaKey();

  const harness = createHarness([
    expiredStory("story-lease", [{ key }], OWNER, {
      cleanupLease: {
        token: "another-cleanup",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(harness.stories.length, 1);
  assert.equal(result.skippedStories, 1);
});

test("recovers a Story with an expired cleanup lease", async () => {
  const key = mediaKey();

  const harness = createHarness([
    expiredStory("story-old-lease", [{ key }], OWNER, {
      cleanupLease: {
        token: "expired-cleanup",
        expiresAt: new Date(Date.now() - 60_000),
      },
    }),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, [key]);
  assert.equal(harness.stories.length, 0);
  assert.equal(result.deletedStories, 1);
});

test("retains a Story with an invalid or foreign-owner media key", async () => {
  const foreignKey = mediaKey(OTHER_OWNER);

  const harness = createHarness([
    expiredStory("story-6", [{ key: foreignKey }]),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, []);
  assert.equal(harness.stories.length, 1);
  assert.equal(result.failedStories, 1);
  assert.equal(result.deletedStories, 0);
});

test("retains the Story when R2 deletion fails", async () => {
  const key = mediaKey();

  const harness = createHarness(
    [expiredStory("story-7", [{ key }])],
    { failDelete: true }
  );

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.equal(harness.stories.length, 1);
  assert.equal(harness.failedStories, undefined);
  assert.equal(result.failedStories, 1);
  assert.equal(result.deletedStories, 0);

  assert.equal(
    harness.stories[0].cleanupLease,
    undefined
  );
});

test("deletes duplicate media keys only once", async () => {
  const key = mediaKey();

  const harness = createHarness([
    expiredStory("story-8", [{ key }, { key }]),
  ]);

  const result = await cleanupExpiredStories(
    harness.env,
    harness.databaseRunner
  );

  assert.deepEqual(harness.deletedKeys, [key]);
  assert.equal(result.deletedObjects, 1);
  assert.equal(result.deletedStories, 1);
});

test("rejects cleanup when MEDIA_BUCKET is missing", async () => {
  await assert.rejects(
    cleanupExpiredStories({}, async () => ({})),
    /MEDIA_BUCKET is not configured/
  );
});
