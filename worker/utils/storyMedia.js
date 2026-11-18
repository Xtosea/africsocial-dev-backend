const STORY_MEDIA_EXTENSIONS =
  "jpg|png|webp|mp4|webm|mov|m4v|3gp|mp3|wav|ogg|m4a|aac";

export function isOwnedStoryMediaKey(key, userId) {
  if (typeof key !== "string" || typeof userId !== "string") {
    return false;
  }

  if (!/^[a-f0-9]{24}$/i.test(userId)) {
    return false;
  }

  const pattern = new RegExp(
    `^stories/([a-f0-9]{24})/\\d+-[a-f0-9]{32}\\.(?:${STORY_MEDIA_EXTENSIONS})$`,
    "i"
  );

  const match = pattern.exec(key);

  return Boolean(
    match && match[1].toLowerCase() === userId.toLowerCase()
  );
}

export function extractStoryMediaKey(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  if (value.startsWith("stories/")) {
    return value;
  }

  try {
    const url = new URL(value, "https://media.invalid");

    if (url.pathname === "/api/media") {
      const key = url.searchParams.get("key");
      return key?.startsWith("stories/") ? key : null;
    }

    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    return path.startsWith("stories/") ? path : null;
  } catch {
    return null;
  }
}

export function getStoryMediaKeys(media) {
  if (!Array.isArray(media)) {
    return [];
  }

  return [
    ...new Set(
      media
        .filter((item) => item && typeof item === "object")
        .flatMap((item) =>
          ["key", "thumbnailKey", "url", "thumbnailUrl"]
            .map((field) => extractStoryMediaKey(item[field]))
            .filter(Boolean)
        )
    ),
  ];
}
