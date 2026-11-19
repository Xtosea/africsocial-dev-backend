import { ObjectId } from "mongodb";
import { authenticate } from "../utils/auth.js";
import { getDatabase } from "../utils/db.js";
import { createPostAccessChecker } from "../utils/postAccess.js";
import { verifyMediaAccessToken } from "../utils/mediaAccessToken.js";

function responseHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Range, If-None-Match",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, ETag",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { ...responseHeaders(), ...extraHeaders },
  });
}

function isValidMediaKey(key) {
  return typeof key === "string" &&
    /^(stories|reels)\/[a-f0-9]{24}\/\d+-[a-f0-9]{32}\.(jpg|png|webp|mp4|webm|mov|m4v|3gp)$/i.test(key);
}

function extractR2Key(value) {
  if (typeof value !== "string" || !value) return null;

  try {
    const url = new URL(value, "https://media.invalid");

    if (url.pathname === "/api/media") {
      return url.searchParams.get("key");
    }

    return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function referencesKey(media, key) {
  if (!Array.isArray(media)) return false;

  return media.some((item) => {
    if (!item || typeof item !== "object") return false;

    return (
      item.key === key ||
      item.thumbnailKey === key ||
      extractR2Key(item.url) === key ||
      extractR2Key(item.thumbnailUrl) === key
    );
  });
}

async function getAuthor(db, userId) {
  if (!userId || !ObjectId.isValid(String(userId))) return null;

  return db.collection("users").findOne(
    { _id: new ObjectId(String(userId)) },
    { projection: { isPrivate: 1 } }
  );
}

function parseRange(value, size) {
  if (!value) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());

  if (!match || (!match[1] && !match[2])) {
    return { invalid: true };
  }

  let offset;
  let length;

  if (!match[1]) {
    const suffix = Number(match[2]);

    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { invalid: true };
    }

    length = Math.min(suffix, size);
    offset = size - length;
  } else {
    offset = Number(match[1]);

    if (!Number.isSafeInteger(offset) || offset >= size) {
      return { invalid: true };
    }

    const end = match[2] ? Number(match[2]) : size - 1;

    if (!Number.isSafeInteger(end) || end < offset) {
      return { invalid: true };
    }

    length = Math.min(end, size - 1) - offset + 1;
  }

  if (length <= 0) return { invalid: true };

  return {
    offset,
    length,
    end: offset + length - 1,
  };
}

export async function serveProtectedMedia(
  request,
  env,
  dependencies = {}
) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const isDownloadRequest = url.searchParams.get("download") === "1";

    if (!isValidMediaKey(key)) {
      return json({ error: "Invalid media key" }, 400);
    }

    const bucket = dependencies.bucket || env.MEDIA_BUCKET;

    if (!bucket) {
      return json({ error: "Media storage is unavailable" }, 503);
    }

      // Public media can be requested without authentication.
      // Prefer the normal authenticated session.
      // Browser media elements can instead use a short-lived, key-scoped token.
      let viewerId = null;

      try {
        const authenticateUser =
          dependencies.authenticate || authenticate;
        viewerId = await authenticateUser(request, env);
      } catch {
        viewerId = null;
      }

      if (!viewerId) {
        const accessToken = url.searchParams.get("access_token");

        if (accessToken) {
          const verifyToken =
            dependencies.verifyMediaAccessToken || verifyMediaAccessToken;

          const tokenResult = await verifyToken({
            token: accessToken,
            secret: env.JWT_SECRET,
            key,
          });

          if (tokenResult?.viewerId) {
            viewerId = new ObjectId(tokenResult.viewerId);
          }
        }
      }

      const getDb = dependencies.getDatabase || getDatabase;
    const db = await getDb(env);

    const createAccess =
      dependencies.createPostAccessChecker || createPostAccessChecker;

    let authorized = false;
    let publiclyCacheable = false;

    if (key.startsWith("stories/")) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const encodedKey = encodeURIComponent(key);
      const escapedEncodedKey = encodedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const keySuffix = new RegExp(`${escapedKey}$`, "i");
      const encodedKeySuffix = new RegExp(`${escapedEncodedKey}$`, "i");

      const story = await db.collection("stories").findOne({
        expiresAt: { $gt: new Date() },
        $or: [
          { "media.key": key },
          { "media.thumbnailKey": key },
          { "media.url": { $regex: keySuffix } },
          { "media.url": { $regex: encodedKeySuffix } },
          { "media.thumbnailUrl": { $regex: keySuffix } },
          { "media.thumbnailUrl": { $regex: encodedKeySuffix } },
        ],
      });

      if (story && referencesKey(story.media, key)) {
        const access = createAccess(db, viewerId);

        authorized = await access.canViewPost({
          _id: story._id,
          user: story.user,
          visibility: story.visibility || "public",
          isSharedPost: false,
        });

        if (authorized) {
          const author = await getAuthor(db, story.user);
          const visibility = story.visibility || "public";

          publiclyCacheable =
            visibility === "public" &&
            author?.isPrivate !== true;
        }
      }
    } else {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const encodedKey = encodeURIComponent(key);
      const escapedEncodedKey = encodedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const keySuffix = new RegExp(`${escapedKey}$`, "i");
      const encodedKeySuffix = new RegExp(`${escapedEncodedKey}$`, "i");

      const posts = await db.collection("posts")
        .find({
          $or: [
            { "media.key": key },
            { "media.thumbnailKey": key },
            { "media.url": { $regex: keySuffix } },
            { "media.url": { $regex: encodedKeySuffix } },
            { "media.thumbnailUrl": { $regex: keySuffix } },
            { "media.thumbnailUrl": { $regex: encodedKeySuffix } },
          ],
        })
        .limit(100)
        .toArray();

      const access = createAccess(db, viewerId);

      for (const post of posts) {
        if (!referencesKey(post.media, key)) continue;

        if (!(await access.canViewPost(post))) continue;

        if (isDownloadRequest) {
          const isOwner =
            viewerId && String(post.user) === String(viewerId);
          const isVideoKey = /\.(mp4|webm|mov|m4v|3gp)$/i.test(key);

          if (
            post.isReel !== true ||
            !isVideoKey ||
            (post.allowDownload !== true && !isOwner)
          ) {
            continue;
          }
        }

        authorized = true;

        if (isDownloadRequest) {
          publiclyCacheable = false;
          continue;
        }

        // Shared posts are conservatively never publicly cached.
        if (post.isSharedPost === true) continue;

        const author = await getAuthor(db, post.user);
        const visibility = post.visibility || "public";

        if (
          visibility === "public" &&
          author?.isPrivate !== true
        ) {
          publiclyCacheable = true;
        }
      }
    }

    if (!authorized) {
      return json({ error: "Media not found" }, 404);
    }

    let range = null;
    let status = 200;
    let contentRange = null;

    const rangeHeader = request.method === "GET" ? request.headers.get("Range") : null;

    if (rangeHeader) {
      const head = await bucket.head(key);

      if (!head) {
        return json({ error: "Media not found" }, 404);
      }

      range = parseRange(rangeHeader, head.size);

      if (!range || range.invalid) {
        return new Response(null, {
          status: 416,
          headers: {
            ...responseHeaders(),
            "Content-Range": `bytes */${head.size}`,
            "Cache-Control": "private, no-store",
          },
        });
      }

      status = 206;

      contentRange =
        `bytes ${range.offset}-${range.end}/${head.size}`;
    }

    const object = request.method === "HEAD"
      ? await bucket.head(key)
      : range
        ? await bucket.get(key, {
            range: {
              offset: range.offset,
              length: range.length,
            },
          })
        : await bucket.get(key);

    if (!object) {
      return json({ error: "Media not found" }, 404);
    }

    const headers = new Headers(responseHeaders());

    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType || "application/octet-stream"
    );

    headers.set("Accept-Ranges", "bytes");

    if (object.httpEtag) {
      headers.set("ETag", object.httpEtag);
    }

    if (object.uploaded) {
      headers.set("Last-Modified", object.uploaded.toUTCString());
    }

    if (range) {
      headers.set("Content-Length", String(range.length));
      headers.set("Content-Range", contentRange);
    } else {
      headers.set("Content-Length", String(object.size));
    }

    headers.set(
      "Cache-Control",
      publiclyCacheable
        ? "public, max-age=60, s-maxage=60"
        : "private, no-store"
    );

    if (
      !range &&
      object.httpEtag &&
      request.headers.get("If-None-Match") === object.httpEtag
    ) {
      return new Response(null, {
        status: 304,
        headers,
      });
    }

    return new Response(
      request.method === "HEAD" ? null : object.body,
      { status, headers }
    );
  } catch (error) {
    console.error("Protected media error:", error);

    return json(
      { error: "Unable to retrieve media" },
      500,
      { "Cache-Control": "private, no-store" }
    );
  }
}
