import { ObjectId } from "mongodb";

export function createPostAccessChecker(db, viewerId) {
  const usersCache = new Map();
  const postsCache = new Map();

  const viewerKey = String(viewerId);

  async function getUser(id) {
    const key = String(id);

    if (!ObjectId.isValid(key)) return null;

    if (!usersCache.has(key)) {
      usersCache.set(
        key,
        db.collection("users").findOne({
          _id: new ObjectId(key),
        })
      );
    }

    return usersCache.get(key);
  }

  async function getPost(id) {
    const key = String(id);

    if (!ObjectId.isValid(key)) return null;

    if (!postsCache.has(key)) {
      postsCache.set(
        key,
        db.collection("posts").findOne({
          _id: new ObjectId(key),
        })
      );
    }

    return postsCache.get(key);
  }

  async function areFriends(author, viewer) {
    const authorFriends = Array.isArray(author.friends)
      ? author.friends
      : [];

    const viewerFriends = Array.isArray(viewer.friends)
      ? viewer.friends
      : [];

    const authorHasViewer = authorFriends.some(
      id => String(id) === viewerKey
    );

    const viewerHasAuthor = viewerFriends.some(
      id => String(id) === String(author._id)
    );

    return authorHasViewer && viewerHasAuthor;
  }

  async function canViewPost(post, visited = new Set()) {
    if (!post || !post.user) return false;

    const postKey = String(post._id || "");

    if (postKey && visited.has(postKey)) {
      return false;
    }

    if (postKey) visited.add(postKey);

    const author = await getUser(post.user);

    if (!author) return false;

    const isOwner = String(post.user) === viewerKey;

    const visibility = post.visibility || "public";

    if (!["public", "friends", "private"].includes(visibility)) {
      return false;
    }

    let allowed = false;

    if (isOwner) {
      allowed = true;
    } else if (visibility === "private") {
      allowed = false;
    } else if (
      visibility === "friends" ||
      author.isPrivate === true
    ) {
      const viewer = await getUser(viewerKey);

      allowed = viewer
        ? await areFriends(author, viewer)
        : false;
    } else {
      allowed = true;
    }

    if (!allowed) return false;

    if (post.isSharedPost === true && post.sharedFrom) {
      const original = await getPost(post.sharedFrom);

      if (!original) return false;

      return canViewPost(original, visited);
    }

    return true;
  }

  return {
    canViewPost,
  };
}
