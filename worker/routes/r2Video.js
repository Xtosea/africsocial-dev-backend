import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { authenticate } from "../utils/auth.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders(),
  });
}

const VIDEO_EXTENSIONS = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/ogg": "ogv",
  "video/mpeg": "mpeg",
  "video/3gpp": "3gp",
};

export async function getR2VideoSignedUploadUrl(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    // Normal authenticated AfricSocial user.
    try {
      await authenticate(request, env);
    } catch (error) {
      return json(
        {
          success: false,
          error: error.message || "Authentication required",
        },
        401
      );
    }

    const contentType =
      new URL(request.url).searchParams.get("contentType") || "";

    const extension =
      VIDEO_EXTENSIONS[String(contentType).toLowerCase()] || null;

    if (!extension) {
      return json(
        {
          success: false,
          error: `Unsupported video content type: ${
            contentType || "missing"
          }`,
        },
        400
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
        return json(
          {
            success: false,
            error: `${key} is not configured`,
          },
          500
        );
      }
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
      `post-videos/${Date.now()}-${randomPart}.${extension}`;

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
      "R2 video signed upload URL error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error.message ||
          "Failed to create R2 video upload URL",
      },
      500
    );
  }
}
