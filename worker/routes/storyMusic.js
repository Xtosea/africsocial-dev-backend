import { ObjectId } from "mongodb";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders(),
  });
}

async function authenticateAdmin(request, env, db) {
  if (!env.JWT_SECRET) {
    return {
      error: json(
        {
          success: false,
          error: "JWT_SECRET is not configured",
        },
        500
      ),
    };
  }

  const authHeader =
    request.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return {
      error: json(
        {
          success: false,
          error: "Authentication required",
        },
        401
      ),
    };
  }

  const token = authHeader.slice(7);

  const parts = token.split(".");

  if (parts.length !== 3) {
    return {
      error: json(
        {
          success: false,
          error: "Invalid token",
        },
        401
      ),
    };
  }

  const [encodedHeader, encodedPayload, encodedSignature] =
    parts;

  function base64UrlDecode(input) {
    const base64 = input
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const padded =
      base64 +
      "=".repeat((4 - (base64.length % 4)) % 4);

    return atob(padded);
  }

  try {
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.JWT_SECRET),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["verify"]
    );

    const signature = Uint8Array.from(
      base64UrlDecode(encodedSignature),
      (char) => char.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(
        `${encodedHeader}.${encodedPayload}`
      )
    );

    if (!valid) {
      return {
        error: json(
          {
            success: false,
            error: "Invalid token",
          },
          401
        ),
      };
    }

    const payload = JSON.parse(
      base64UrlDecode(encodedPayload)
    );

    if (
      payload.exp &&
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return {
        error: json(
          {
            success: false,
            error: "Token expired",
          },
          401
        ),
      };
    }

    if (
      !payload.id ||
      !ObjectId.isValid(payload.id)
    ) {
      return {
        error: json(
          {
            success: false,
            error: "Invalid authentication token",
          },
          401
        ),
      };
    }

    const adminUser = await db.collection("users").findOne(
      {
        _id: new ObjectId(payload.id),
      },
      {
        projection: {
          role: 1,
        },
      }
    );

    if (adminUser?.role !== "admin") {
      return {
        error: json(
          {
            success: false,
            error: "Admin access required",
          },
          403
        ),
      };
    }

    return {
      userId: new ObjectId(payload.id),
    };
  } catch (error) {
    console.error("Story Music authentication error:", error);

    return {
      error: json(
        {
          success: false,
          error: "Authentication failed",
        },
        401
      ),
    };
  }
}

export async function getStoryMusic(request, env) {
  try {
    const { getDatabase } = await import("../utils/db.js");
    const db = await getDatabase(env);

    const music = await db
      .collection("storymusics")
      .find({})
      .sort({ title: 1 })
      .toArray();

    return json(music);
  } catch (error) {
    console.error("Get Story Music error:", error);

    return json(
      {
        success: false,
        error: "Failed to load story music",
      },
      500
    );
  }
}

export async function createStoryMusic(request, env) {
  try {
    const { getDatabase } = await import("../utils/db.js");
    const db = await getDatabase(env);

    const auth = await authenticateAdmin(
      request,
      env,
      db
    );

    if (auth.error) {
      return auth.error;
    }

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

    const title =
      typeof body.title === "string"
        ? body.title.trim()
        : "";

    const artist =
      typeof body.artist === "string"
        ? body.artist.trim()
        : "";

    const audioUrl =
      typeof body.audioUrl === "string"
        ? body.audioUrl.trim()
        : "";

    const coverUrl =
      typeof body.coverUrl === "string"
        ? body.coverUrl.trim()
        : "";

    if (!title) {
      return json(
        {
          success: false,
          error: "Title is required",
        },
        400
      );
    }

    if (!audioUrl) {
      return json(
        {
          success: false,
          error: "audioUrl is required",
        },
        400
      );
    }

    const now = new Date();

    const music = {
      title,
      artist,
      audioUrl,
      ...(coverUrl ? { coverUrl } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const result = await db
      .collection("storymusics")
      .insertOne(music);

    return json(
      {
        ...music,
        _id: result.insertedId,
      },
      201
    );
  } catch (error) {
    console.error("Create Story Music error:", error);

    return json(
      {
        success: false,
        error: "Failed to create story music",
      },
      500
    );
  }
}
