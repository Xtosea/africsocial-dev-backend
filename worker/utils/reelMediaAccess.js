import { createMediaAccessToken } from "./mediaAccessToken.js";

const REEL_MEDIA_KEY_PATTERN =
  /^reels\/[a-f\d]{24}\/\d+-[a-f\d]{32}\.(jpg|png|webp|mp4|webm|mov|m4v|3gp|m4a|ogg|mp3|aac)$/i;

export async function signProtectedReelMediaUrl(
  value,
  { viewerId, secret } = {}
) {
  if (
    typeof value !== "string" ||
    !value ||
    !viewerId ||
    typeof secret !== "string"
  ) {
    return value;
  }

  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const mediaUrl = new URL(value, "https://media.invalid");

    if (mediaUrl.pathname !== "/api/media") {
      return value;
    }

    const key = mediaUrl.searchParams.get("key");

    if (!REEL_MEDIA_KEY_PATTERN.test(key || "")) {
      return value;
    }

    const token = await createMediaAccessToken({
      secret,
      key,
      viewerId: String(viewerId),
      ttlSeconds: 300,
    });

    mediaUrl.searchParams.set("access_token", token);

    return isAbsolute
      ? mediaUrl.toString()
      : mediaUrl.pathname + mediaUrl.search + mediaUrl.hash;
  } catch (error) {
    console.error("REEL MEDIA TOKEN ERROR:", error);
    return value;
  }
}
