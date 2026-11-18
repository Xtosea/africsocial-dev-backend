import test from "node:test";
import assert from "node:assert/strict";
import { uploadStoryMediaToR2 } from "../worker/routes/r2.js";

const USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

function makeRequest(contentType, chunks, extraHeaders = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Request("https://example.com/api/r2/story-upload", {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...extraHeaders,
    },
    body,
    duplex: "half",
  });
}

function makeEnvironment() {
  const uploads = [];

  return {
    uploads,
    env: {
      R2_CUSTOM_DOMAIN: "https://media.example.com",
      MEDIA_BUCKET: {
        async put(key, body, options) {
          let size = 0;
          const reader = body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
          }

          uploads.push({ key, size, options });
        },
      },
    },
  };
}

function chunksOfSize(size) {
  const chunks = [];
  const chunkSize = 1024 * 1024;

  while (size > 0) {
    const length = Math.min(size, chunkSize);
    chunks.push(new Uint8Array(length));
    size -= length;
  }

  return chunks;
}

const dependencies = {
  authenticate: async () => USER_ID,
};

test("accepts an image within the 10 MB limit", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest("image/jpeg", [new Uint8Array([1, 2, 3])]);

  const response = await uploadStoryMediaToR2(request, env, dependencies);
  const data = await response.json();

  assert.equal(response.status, 201);
  assert.equal(data.success, true);
  assert.equal(uploads.length, 1);
  assert.match(data.key, /^stories\/[a-f0-9]{24}\//);
});

test("rejects an image exceeding 10 MB without Content-Length", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest(
    "image/jpeg",
    chunksOfSize(10 * 1024 * 1024 + 1)
  );

  const response = await uploadStoryMediaToR2(request, env, dependencies);
  const data = await response.json();

  assert.equal(response.status, 413);
  assert.equal(data.success, false);
  assert.equal(uploads.length, 0);
});

test("accepts a video within the 50 MB limit", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest("video/mp4", [new Uint8Array([1, 2, 3])]);

  const response = await uploadStoryMediaToR2(request, env, dependencies);
  const data = await response.json();

  assert.equal(response.status, 201);
  assert.equal(data.success, true);
  assert.equal(uploads.length, 1);
});

test("rejects a video exceeding 50 MB without Content-Length", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest(
    "video/mp4",
    chunksOfSize(50 * 1024 * 1024 + 1)
  );

  const response = await uploadStoryMediaToR2(request, env, dependencies);
  const data = await response.json();

  assert.equal(response.status, 413);
  assert.equal(data.success, false);
  assert.equal(uploads.length, 0);
});

test("rejects audio uploads from ordinary users", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest("audio/mpeg", [new Uint8Array([1, 2, 3])]);

  const response = await uploadStoryMediaToR2(request, env, dependencies);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.success, false);
  assert.equal(uploads.length, 0);
});

test("rejects an image when Content-Length exceeds 10 MB", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest(
    "image/png",
    [new Uint8Array([1, 2, 3])],
    { "Content-Length": String(10 * 1024 * 1024 + 1) }
  );

  const response = await uploadStoryMediaToR2(request, env, dependencies);

  assert.equal(response.status, 413);
  assert.equal(uploads.length, 0);
});

test("rejects a falsely low Content-Length when actual video exceeds 50 MB", async () => {
  const { env, uploads } = makeEnvironment();
  const request = makeRequest(
    "video/mp4",
    chunksOfSize(50 * 1024 * 1024 + 1),
    { "Content-Length": "3" }
  );

  const response = await uploadStoryMediaToR2(request, env, dependencies);

  assert.equal(response.status, 413);
  assert.equal(uploads.length, 0);
});
