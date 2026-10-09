import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { authenticate } from "../utils/auth.js";
import { getDatabase } from "../utils/db.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders(),
  });
}

const AUDIO_TYPES = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

async function requireAdmin(request, env) {
  const userId = await authenticate(request, env);
  const db = await getDatabase(env);

  const user = await db.collection("users").findOne(
    { _id: userId },
    { projection: { role: 1 } }
  );

  if (!user || user.role !== "admin") {
    const error = new Error("Administrator access required");
    error.status = 403;
    throw error;
  }

  return { userId, db };
}

function handleError(error, operation) {
  console.error(`[StoryMusic] ${operation} failed:`, {
    message: error?.message || String(error),
    status: error?.status || 500,
  });

  return json(
    {
      success: false,
      error: error?.message || "Music service request failed",
    },
    error?.status || 500
  );
}

// GET /api/story-music
// Returns an array because existing frontend components use .map().
export async function getStoryMusic(request, env) {
  try {
    const db = await getDatabase(env);

    const songs = await db
      .collection("storyMusic")
      .find({ active: { $ne: false } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    const result = songs.map((song) => ({
      ...song,
      audioUrl: song.audioUrl || song.url || "",
      url: song.url || song.audioUrl || "",
    }));

    return json(result);
  } catch (error) {
    return handleError(error, "list");
  }
}

// PUT /api/r2/story-music-upload
// Uploads audio to R2. Only administrators can add library files.
export async function uploadStoryMusic(request, env) {
  try {
    const { userId } = await requireAdmin(request, env);

    const contentType = (
      request.headers.get("Content-Type") || ""
    )
      .split(";")[0]
      .trim()
      .toLowerCase();

    const extension = AUDIO_TYPES[contentType];

    if (!extension) {
      return json(
        {
          success: false,
          error: `Unsupported audio type: ${contentType || "missing"}`,
        },
        400
      );
    }

    const declaredSize = Number(
      request.headers.get("Content-Length") || 0
    );

    const maxSize = 20 * 1024 * 1024;

    if (declaredSize > maxSize) {
      return json(
        {
          success: false,
          error: "Audio file exceeds the 20 MB limit",
        },
        413
      );
    }

    const requiredConfig = [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_NAME",
      "R2_CUSTOM_DOMAIN",
    ];

    for (const key of requiredConfig) {
      if (!env[key]) {
        throw new Error(`${key} is not configured`);
      }
    }

    const bytes = await request.arrayBuffer();

    if (bytes.byteLength === 0) {
      return json(
        {
          success: false,
          error: "The uploaded audio file is empty",
        },
        400
      );
    }

    if (bytes.byteLength > maxSize) {
      return json(
        {
          success: false,
          error: "Audio file exceeds the 20 MB limit",
        },
        413
      );
    }

    const s3 = new S3Client({
      region: "auto",
      endpoint:
        `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    const fileName =
      `story-music/${Date.now()}-${crypto.randomUUID()}.${extension}`;

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.R2_BUCKET_NAME,
          Key: fileName,
          Body: new Uint8Array(bytes),
          ContentType: contentType,
        })
      );
    } finally {
      s3.destroy();
    }

    const customDomain = env.R2_CUSTOM_DOMAIN.replace(/\/+$/, "");
    const fileUrl = `${customDomain}/${fileName}`;

    console.log("[StoryMusic] Audio uploaded", {
      userId: String(userId),
      fileName,
      sizeBytes: bytes.byteLength,
    });

    return json({
      success: true,
      fileUrl,
      fileName,
      contentType,
      sizeBytes: bytes.byteLength,
    });
  } catch (error) {
    return handleError(error, "upload");
  }
}

// POST /api/story-music-admin
// Saves a track after its audio file has been uploaded.
export async function saveStoryMusic(request, env) {
  try {
    const { userId, db } = await requireAdmin(request, env);

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          success: false,
          error: "Invalid JSON request body",
        },
        400
      );
    }

    const title = String(body.title || "").trim();
    const artist = String(body.artist || "").trim();
    const audioUrl = String(body.audioUrl || "").trim();

    if (!title) {
      return json(
        {
          success: false,
          error: "Music title is required",
        },
        400
      );
    }

    if (title.length > 150 || artist.length > 150) {
      return json(
        {
          success: false,
          error: "Title and artist must not exceed 150 characters",
        },
        400
      );
    }

    const customDomain = env.R2_CUSTOM_DOMAIN;

    if (!customDomain) {
      throw new Error("R2_CUSTOM_DOMAIN is not configured");
    }

    const expectedPrefix =
      `${customDomain.replace(/\/+$/, "")}/story-music/`;

    if (!audioUrl.startsWith(expectedPrefix)) {
      return json(
        {
          success: false,
          error: "Audio URL must point to the AfricSocial music storage path",
        },
        400
      );
    }

    const song = {
      title,
      artist,
      audioUrl,
      url: audioUrl,
      uploadedBy: userId,
      active: true,
      createdAt: new Date(),
    };

    const result = await db
      .collection("storyMusic")
      .insertOne(song);

    return json({
      success: true,
      message: "Music saved successfully",
      song: {
        ...song,
        _id: result.insertedId,
      },
    }, 201);
  } catch (error) {
    return handleError(error, "save");
  }
}
