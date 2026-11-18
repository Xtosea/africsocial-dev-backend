import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { authenticate } from "../utils/auth.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders(),
  });
}

function getExtension(contentType) {
  const type = String(contentType || "").toLowerCase();

  const extensions = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
  };

  return extensions[type] || null;
}


export async function uploadStoryMusicToR2(request, env) {
  try {
    let userId;

    try {
      userId = await authenticate(request, env);
    } catch (error) {
      return json(
        {
          success: false,
          error: error.message || "Authentication required",
        },
        401
      );
    }

    const { getDatabase } = await import("../utils/db.js");
    const db = await getDatabase(env);

    const user = await db.collection("users").findOne(
      { _id: userId },
      {
        projection: {
          role: 1,
        },
      }
    );

    if (user?.role !== "admin") {
      return json(
        {
          success: false,
          error: "Admin access required",
        },
        403
      );
    }

    const contentType =
      request.headers.get("Content-Type") || "";

    const extension = getExtension(contentType);

    if (!extension) {
      return json(
        {
          success: false,
          error: "Unsupported audio content type",
        },
        400
      );
    }

    if (!env.MEDIA_BUCKET) {
      return json(
        {
          success: false,
          error: "MEDIA_BUCKET is not configured",
        },
        500
      );
    }

    if (!request.body) {
      return json(
        {
          success: false,
          error: "Audio request body is required",
        },
        400
      );
    }

    if (!env.R2_CUSTOM_DOMAIN) {
      return json(
        {
          success: false,
          error: "R2_CUSTOM_DOMAIN is not configured",
        },
        500
      );
    }

    const randomPart = crypto.randomUUID().replace(/-/g, "");

    const fileName =
      `story-music/${Date.now()}-${randomPart}.${extension}`;

    await env.MEDIA_BUCKET.put(
      fileName,
      request.body,
      {
        httpMetadata: {
          contentType,
        },
      }
    );

    const customDomain =
      env.R2_CUSTOM_DOMAIN.replace(/\/+$/, "");

    return json({
      success: true,
      fileUrl: `${customDomain}/${fileName}`,
      fileName,
      contentType,
    });
  } catch (error) {
    console.error(
      "Native R2 Story Music upload error:",
      error
    );

    return json(
      {
        success: false,
        error: "Failed to upload Story Music to R2",
      },
      500
    );
  }
}

export async function getR2SignedUploadUrl(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    // Authenticate the requester.
    let userId;

    try {
      userId = await authenticate(request, env);
    } catch (error) {
      return json(
        {
          success: false,
          error: error.message || "Authentication required",
        },
        401
      );
    }

    const { getDatabase } = await import("../utils/db.js");
    const db = await getDatabase(env);

    // Only administrators can request Story Music upload URLs.
    const user = await db.collection("users").findOne(
      { _id: userId },
      {
        projection: {
          role: 1,
        },
      }
    );

    if (user?.role !== "admin") {
      return json(
        {
          success: false,
          error: "Admin access required",
        },
        403
      );
    }

    const contentType =
      new URL(request.url).searchParams.get("contentType") || "";

    const extension = getExtension(contentType);

    if (!extension) {
      return json(
        {
          success: false,
          error: "Unsupported audio content type",
        },
        400
      );
    }

    if (!env.R2_ACCOUNT_ID) {
      return json(
        {
          success: false,
          error: "R2_ACCOUNT_ID is not configured",
        },
        500
      );
    }

    if (!env.R2_ACCESS_KEY_ID) {
      return json(
        {
          success: false,
          error: "R2_ACCESS_KEY_ID is not configured",
        },
        500
      );
    }

    if (!env.R2_SECRET_ACCESS_KEY) {
      return json(
        {
          success: false,
          error: "R2_SECRET_ACCESS_KEY is not configured",
        },
        500
      );
    }

    if (!env.R2_BUCKET_NAME) {
      return json(
        {
          success: false,
          error: "R2_BUCKET_NAME is not configured",
        },
        500
      );
    }

    if (!env.R2_CUSTOM_DOMAIN) {
      return json(
        {
          success: false,
          error: "R2_CUSTOM_DOMAIN is not configured",
        },
        500
      );
    }

    const endpoint =
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

    const s3 = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    const randomPart = crypto.randomUUID().replace(/-/g, "");

    const fileName =
      `story-music/${Date.now()}-${randomPart}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: fileName,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: 300,
    });

    const customDomain =
      env.R2_CUSTOM_DOMAIN.replace(/\/+$/, "");
    return json({
      success: true,
      uploadUrl,
      fileUrl: `${customDomain}/${fileName}`,
      fileName,
      contentType,
      expiresIn: 300,
    });
  } catch (error) {
    console.error(
      "R2 signed upload URL error:",
      error
    );

    return json(
      {
        success: false,
        error: "Failed to create R2 upload URL",
      },
      500
    );
  }
}

// ================= REEL MEDIA SIGNED UPLOAD =================

export async function getReelMediaSignedUploadUrl(request, env) {
  try {
    const userId = await authenticate(request, env);

    const contentType = (
      new URL(request.url).searchParams.get("contentType") || ""
    ).toLowerCase();

    const allowedTypes = {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/quicktime": "mov",
      "video/x-m4v": "m4v",
      "video/3gpp": "3gp",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };

    const extension = allowedTypes[contentType];

    if (!extension) {
      return json({
        success: false,
        error: "Unsupported Reel media content type",
      }, 400);
    }

    if (
      !env.R2_ACCOUNT_ID ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY ||
      !env.REELS_R2_BUCKET_NAME
    ) {
      console.error("Reel upload: R2 configuration is incomplete");

      return json({
        success: false,
        error: "R2 upload service is not fully configured",
      }, 500);
    }

    const endpoint =
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

    const s3 = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    const randomPart = crypto.randomUUID().replace(/-/g, "");

    const fileName =
      `reels/${userId.toString()}/${Date.now()}-${randomPart}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: env.REELS_R2_BUCKET_NAME,
      Key: fileName,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: 300,
    });

    const mediaOrigin = new URL(request.url).origin;

    return json({
      success: true,
      uploadUrl,
      fileUrl: `${mediaOrigin}/api/media?key=${encodeURIComponent(fileName)}`,
      fileName,
      contentType,
      expiresIn: 300,
    });
  } catch (error) {
    console.error("Reel media signed URL error:", error);

    const authError = [
      "Authentication required",
      "Invalid token",
      "Token expired",
      "Invalid authentication token",
      "Invalid user ID",
    ].includes(error.message);

    return json({
      success: false,
      error: error.message || "Failed to create Reel upload URL",
    }, authError ? 401 : 500);
  }
}

/* ============================================================
   ORDINARY USER STORY MEDIA UPLOAD
   Uses the development MEDIA_BUCKET binding.
   Files are isolated under stories/{userId}/.
============================================================ */

export async function uploadStoryMediaToR2(request, env, dependencies = {}) {
  let tooLarge = false;

  try {
    const authenticateUser = dependencies.authenticate || authenticate;
    const userId = await authenticateUser(request, env);

    if (!env.MEDIA_BUCKET) {
      return json({
        success: false,
        error: "Story media storage is not configured",
      }, 500);
    }

    const contentType = String(
      request.headers.get("Content-Type") || ""
    ).split(";")[0].trim().toLowerCase();

    const allowedTypes = {
      "image/jpeg": { extension: "jpg", maxBytes: 10 * 1024 * 1024 },
      "image/png": { extension: "png", maxBytes: 10 * 1024 * 1024 },
      "image/webp": { extension: "webp", maxBytes: 10 * 1024 * 1024 },

      "video/mp4": { extension: "mp4", maxBytes: 50 * 1024 * 1024 },
      "video/webm": { extension: "webm", maxBytes: 50 * 1024 * 1024 },
      "video/quicktime": { extension: "mov", maxBytes: 50 * 1024 * 1024 },
      "video/x-m4v": { extension: "m4v", maxBytes: 50 * 1024 * 1024 },
      "video/3gpp": { extension: "3gp", maxBytes: 50 * 1024 * 1024 },
    };

    const mediaType = allowedTypes[contentType];

    if (!mediaType) {
      return json({
        success: false,
        error: "Unsupported Story media type. Audio uploads are not permitted.",
      }, 400);
    }

    if (!request.body) {
      return json({
        success: false,
        error: "No Story media file was provided",
      }, 400);
    }

    const maxBytes = mediaType.maxBytes;
    const contentLengthHeader = request.headers.get("Content-Length");

    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);

      if (!Number.isFinite(contentLength) || contentLength < 0) {
        return json({
          success: false,
          error: "Invalid Content-Length header",
        }, 400);
      }

      if (contentLength > maxBytes) {
        return json({
          success: false,
          error: `Story media must not exceed ${maxBytes / (1024 * 1024)} MB`,
        }, 413);
      }
    }

    const randomPart = crypto.randomUUID().replace(/-/g, "");
    const extension = mediaType.extension;

    const key =
      `stories/${String(userId)}/${Date.now()}-${randomPart}.${extension}`;

    let uploadedBytes = 0;

    const limitedBody = request.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          uploadedBytes += chunk.byteLength;

          if (uploadedBytes > maxBytes) {
            tooLarge = true;
            controller.error(
              new Error("Story media exceeds its permitted size")
            );
            return;
          }

          controller.enqueue(chunk);
        },
      })
    );

    await env.MEDIA_BUCKET.put(key, limitedBody, {
      httpMetadata: {
        contentType,
      },
    });


    return json({
      success: true,
      key,
      fileName: key,
      fileUrl: `${new URL(request.url).origin}/api/media?key=${encodeURIComponent(key)}`,
      contentType,
      size: uploadedBytes,
    }, 201);

  } catch (error) {
    if (tooLarge) {
      return json({
        success: false,
        error: "Story media exceeds its permitted upload size",
      }, 413);
    }

    console.error("Story media upload error:", error);

    const authError = [
      "Authentication required",
      "Invalid token",
      "Token expired",
      "Invalid authentication token",
      "Invalid user ID",
    ].includes(error.message);

    return json({
      success: false,
      error: error.message || "Story media upload failed",
    }, authError ? 401 : 500);
  }
}
