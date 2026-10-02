import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
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

  return extensions[type] || "bin";
}

export async function getR2SignedUploadUrl(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    const contentType =
      new URL(request.url).searchParams.get("contentType") ||
      "application/octet-stream";

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

    const extension = getExtension(contentType);

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

    const customDomain = env.R2_CUSTOM_DOMAIN.replace(/\/+$/, "");

    return json({
      success: true,
      uploadUrl,
      fileUrl: `${customDomain}/${fileName}`,
      fileName,
      contentType,
      expiresIn: 300,
    });
  } catch (error) {
    console.error("R2 signed upload URL error:", error);

    return json(
      {
        success: false,
        error: "Failed to create R2 upload URL",
      },
      500
    );
  }
}
