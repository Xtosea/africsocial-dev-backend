import { ObjectId } from "mongodb";
import { getDatabase } from "../utils/db.js";
import { createPostAccessChecker } from "../utils/postAccess.js";

const FRONTEND_URL = "https://dev.africsocial.com";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeMediaUrl(value) {
  if (!value || typeof value !== "string") return null;

  try {
    const url = new URL(value, FRONTEND_URL);

    if (url.protocol !== "https:") return null;

    return url.href;
  } catch {
    return null;
  }
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function htmlResponse(
  html,
  status = 200,
  cacheControl = "public, max-age=60, s-maxage=300"
) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function getSocialPreview(request, env) {
  try {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/post\/([a-fA-F0-9]{24})\/?$/);

    if (!match || !ObjectId.isValid(match[1])) {
      return htmlResponse("Invalid post ID", 400);
    }

    const postId = match[1];
    const db = await getDatabase(env);

    const post = await db.collection("posts").findOne({
      _id: new ObjectId(postId),
    });

    if (!post) {
      return htmlResponse(
        "<!DOCTYPE html><html><head><title>Post not found</title></head><body><h2>This post is unavailable.</h2><a href=\"https://dev.africsocial.com\">Visit AfricSocial</a></body></html>",
        404,
        "no-store"
      );
    }

    // Social previews are public, so only publicly viewable posts qualify.
    const access = createPostAccessChecker(db, null);
    if (!(await access.canViewPost(post))) {
      return htmlResponse(
        "<!DOCTYPE html><html><head><title>Post unavailable</title></head><body><h2>This post is unavailable.</h2><a href=\"https://dev.africsocial.com\">Visit AfricSocial</a></body></html>",
        404,
        "no-store"
      );
    }

    // Retrieve the post author.
    let author = null;
    const authorId = post.user?._id || post.user;

    if (authorId && ObjectId.isValid(String(authorId))) {
      author = await db.collection("users").findOne(
        { _id: new ObjectId(String(authorId)) },
        {
          projection: {
            name: 1,
            username: 1,
            profilePic: 1,
          },
        }
      );
    }

    const authorName =
      author?.name ||
      author?.username ||
      "AfricSocial member";

    const media = Array.isArray(post.media) ? post.media : [];

    const imageMedia = media.find(
      (item) =>
        item?.type === "image" &&
        (item.url || item.secure_url || item.src)
    );

    const videoMedia = media.find(
      (item) =>
        item?.type === "video" &&
        (item.url || item.secure_url || item.src)
    );

    let videoUrl = null;
    let imageUrl = null;

    if (imageMedia) {
      imageUrl = safeMediaUrl(
        imageMedia.url || imageMedia.secure_url || imageMedia.src
      );
    }

    if (!imageUrl && videoMedia) {
      videoUrl = safeMediaUrl(
        videoMedia.url || videoMedia.secure_url || videoMedia.src
      );

      imageUrl = safeMediaUrl(
        videoMedia.thumbnailUrl ||
        videoMedia.thumbnail ||
        videoMedia.poster
      );
    }

    if (!imageUrl) {
      imageUrl = `${FRONTEND_URL}/social-preview.png`;
    }

    const content = String(post.content || post.title || "").trim();

    const title = content
      ? `${authorName}: ${content.slice(0, 80)}`
      : `${authorName} shared a post on AfricSocial`;

    const likesCount = Array.isArray(post.likes)
      ? post.likes.length
      : Number(post.likes) || 0;

    const commentsCount = Array.isArray(post.comments)
      ? post.comments.length
      : Number(post.comments) || 0;

    const description =
      `${likesCount} likes • ${commentsCount} comments • View on AfricSocial`;

    const redirectUrl =
      `${FRONTEND_URL}/post/${postId}`;

    const shareUrl = url.href;

    const safeTitle = escapeHtml(title);
    const safeDescription = escapeHtml(description);
    const safeImage = escapeHtml(imageUrl);
    const safeRedirect = escapeHtml(redirectUrl);
    const safeShareUrl = escapeHtml(shareUrl);

    const structuredData = safeJson({
      "@context": "https://schema.org",
      "@type": "SocialMediaPosting",
      headline: title,
      description,
      image: imageUrl,
      url: redirectUrl,
      author: {
        "@type": "Person",
        name: authorName,
      },
    });

    const videoMetadata = videoUrl
      ? `
        <meta property="og:video" content="${escapeHtml(videoUrl)}">
        <meta property="og:video:secure_url" content="${escapeHtml(videoUrl)}">
        <meta property="og:video:type" content="video/mp4">
      `
      : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <meta name="robots" content="index, follow">

  <link rel="canonical" href="${safeShareUrl}">

  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:image" content="${safeImage}">
  <meta property="og:image:secure_url" content="${safeImage}">
  <meta property="og:url" content="${safeShareUrl}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="AfricSocial">

  ${videoMetadata}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  <meta name="twitter:image" content="${safeImage}">

  <script type="application/ld+json">${structuredData}</script>

  <script>
    setTimeout(() => {
      window.location.replace(${JSON.stringify(redirectUrl)});
    }, 2500);
  </script>
</head>

<body>
  <main style="font-family:Arial,sans-serif;max-width:650px;margin:40px auto;padding:20px;text-align:center;">
    <h2>${safeTitle}</h2>
    <img
      src="${safeImage}"
      alt="AfricSocial post preview"
      style="max-width:100%;height:auto;border-radius:12px;"
    >
    <p>${safeDescription}</p>
    <p>Opening AfricSocial...</p>
    <a href="${safeRedirect}">Open Post</a>
  </main>
</body>
</html>`;

    return htmlResponse(html);
  } catch (error) {
    console.error("SOCIAL PREVIEW ERROR:", error);

    return htmlResponse(
      "Unable to load this post preview.",
      500
    );
  }
}
