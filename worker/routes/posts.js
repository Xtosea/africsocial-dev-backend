import { ObjectId } from "mongodb";
import { getDatabase, debugDbOperation, withDatabaseRetry, withFreshDatabase } from "../utils/db.js";
import { authenticate } from "../utils/auth.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders(),
  });
}

function isAuthError(err) {
  return [
    "Authentication required",
    "Invalid token",
    "Token expired",
    "Invalid authentication token",
    "Invalid user ID",
  ].includes(err.message);
}

function validId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

/* ================= USER HELPERS ================= */

async function getUsersMap(db, ids) {
  const validIds = [
    ...new Set(
      ids
        .filter(Boolean)
        .map(String)
        .filter(ObjectId.isValid)
    ),
  ];

  if (!validIds.length) return new Map();

  const users = await debugDbOperation(
  "posts.populate.users",
  () =>
    db.collection("users")
      .find({
        _id: {
          $in: validIds.map(id => new ObjectId(id)),
        },
      })
      .project({
        name: 1,
        profilePic: 1,
        verified: 1,
        verificationBadge: 1,
      })
      .toArray()
);

return new Map(
  users.map(user => [String(user._id), user])
);
}

async function populatePosts(db, posts) {
  if (!posts.length) return posts;

  const userIds = [];

  for (const post of posts) {
    if (post.user) userIds.push(post.user);
    if (post.originalAuthor) userIds.push(post.originalAuthor);

    if (Array.isArray(post.taggedFriends)) {
      for (const id of post.taggedFriends) {
        if (ObjectId.isValid(String(id))) {
          userIds.push(id);
        }
      }
    }

    if (Array.isArray(post.comments)) {
      for (const comment of post.comments) {
        if (comment.user) userIds.push(comment.user);
      }
    }
  }

  const userMap = await getUsersMap(db, userIds);

  return posts.map(post => {
    const result = { ...post };

    if (post.user) {
      result.user =
        userMap.get(String(post.user)) || post.user;
    }

    if (post.originalAuthor) {
      result.originalAuthor =
        userMap.get(String(post.originalAuthor)) ||
        post.originalAuthor;
    }

    if (Array.isArray(post.taggedFriends)) {
      result.taggedFriends = post.taggedFriends.map(id =>
        userMap.get(String(id)) || id
      );
    }

    if (Array.isArray(post.comments)) {
      result.comments = post.comments.map(comment => ({
        ...comment,
        user: comment.user
          ? userMap.get(String(comment.user)) || comment.user
          : comment.user,
      }));
    }

    return result;
  });
}

/* ================= POINTS ================= */

async function addPoints(db, userId, amount, type) {
  if (!userId || !amount) return;

  const fieldMap = {
    reel_like: "reelLikes",
    reel_view: "reelViews",
    video_like: "videoLikes",
    video_view: "videoViews",
    story_like: "storyLikes",
    story_view: "storyViews",
    referral: "referralPoints",
    leaderboard: "leaderboardPoints",
  };

  const field = fieldMap[type];

  const increment = {
    points: amount,
  };

  if (field) {
    increment[field] = amount;
  }

  await db.collection("wallets").updateOne(
    { user: new ObjectId(userId) },
    {
      $inc: increment,
      $set: {
        updatedAt: new Date(),
      },
      $setOnInsert: {
        user: new ObjectId(userId),
        balance: 0,
        lifetimeEarned: 0,
        pending: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  await db.collection("transactions").insertOne({
    user: new ObjectId(userId),
    type: "points",
    category: type,
    points: amount,
    amount: 0,
    currency: "NGN",
    paymentMethod: "wallet",
    reference: `POINTS-${type}-${Date.now()}`,
    status: "success",
    description: `Earned ${amount} points`,
    metadata: {
      source: type,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.collection("notifications").insertOne({
    recipient: new ObjectId(userId),
    type: "POINT_REWARD",
    text: `You earned ${amount} points`,
    count: 1,
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/* ================= NOTIFICATION ================= */

async function claimLikeReward(db, collectionName, contentId, userId) {
  const uid =
    userId instanceof ObjectId
      ? userId
      : new ObjectId(String(userId));

  const result = await db.collection(collectionName).updateOne(
    {
      _id: contentId,
      likeRewardedBy: {
        $nin: [uid, String(userId)],
      },
    },
    {
      $addToSet: {
        likeRewardedBy: uid,
      },
      $set: {
        updatedAt: new Date(),
      },
    }
  );

  return result.modifiedCount === 1;
}

async function markLikeRewarded(db, collectionName, contentId, userId) {
  const uid =
    userId instanceof ObjectId
      ? userId
      : new ObjectId(String(userId));

  await db.collection(collectionName).updateOne(
    { _id: contentId },
    {
      $addToSet: {
        likeRewardedBy: uid,
      },
      $set: {
        updatedAt: new Date(),
      },
    }
  );
}

async function sendNotification(
  db,
  {
    recipient,
    sender,
    type,
    text,
    post,
  }
) {
  if (!recipient) return;

  const recipientId = new ObjectId(recipient);
  const senderId =
    sender && ObjectId.isValid(String(sender))
      ? new ObjectId(sender)
      : undefined;

  const postId =
    post && ObjectId.isValid(String(post))
      ? new ObjectId(post)
      : undefined;

  const groupable = [
    "LIKE",
    "COMMENT",
    "REEL_LIKE",
    "STORY_LIKE",
  ].includes(type);

  if (groupable && postId) {
    const existing =
      await db.collection("notifications").findOne({
        recipient: recipientId,
        type,
        post: postId,
        read: false,
      });

    if (existing) {
      const update = {
        $inc: {
          count: 1,
        },
        $set: {
          updatedAt: new Date(),
          sender: senderId,
        },
      };

      if (senderId) {
        update.$addToSet = {
          senders: senderId,
        };
      }

      await db.collection("notifications").updateOne(
        { _id: existing._id },
        update
      );

      return;
    }
  }

  const notification = {
    recipient: recipientId,
    type,
    text: text || "",
    count: 1,
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (senderId) {
    notification.sender = senderId;
    notification.senders = [senderId];
  }

  if (postId) {
    notification.post = postId;
  }

  await db.collection("notifications").insertOne(
    notification
  );
}

/* ================= CREATE POST ================= */

export async function createPost(request, env) {
  try {
    const userId = await authenticate(request, env);
    const db = await getDatabase(env);
    const body = await request.json();

    const {
      content,
      feeling,
      location,
      taggedFriends,
      media,
      textColor,
      backgroundStyle,
      fontStyle,
      editor,
      type,
      link,
      title,
      category,
      tags,
    } = body;

    const post = {
      user: userId,
      content: content || "",
      media: Array.isArray(media) ? media : [],
      type: type || "text",
      link: link || null,
      feeling: feeling || "",
      location: location || "",
      taggedFriends: Array.isArray(taggedFriends)
        ? taggedFriends
        : [],
      textColor: textColor || "#000000",
      backgroundStyle:
        backgroundStyle || "bg-white",
      fontStyle: fontStyle || "font-sans",
      editor: editor ?? null,
      title: title || "",
      category: category || "general",
      tags: Array.isArray(tags) ? tags : [],
      isSharedPost: false,
      isReel: false,
      likes: [],
      reactions: [],
      comments: [],
      shares: 0,
      savedBy: [],
      pinned: false,
      sponsored: false,
      promotionBudget: 0,
      adClicks: 0,
      aiScore: 0,
      viralScore: 0,
      viral: false,
      multiplier: 1,
      watchTime: 0,
      watchSessions: [],
      engagementPoints: 0,
      earnings: 0,
      viewedBy: [],
      viewsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result =
      await db.collection("posts").insertOne(post);

    post._id = result.insertedId;

    const populated =
      await populatePosts(db, [post]);

    return json({
      success: true,
      post: populated[0],
    }, 201);

  } catch (err) {
    console.error(
      "CREATE POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= GET FEED ================= */
export async function getPosts(request, env) {
  try {
    const feedStartedAt = Date.now();

    console.log("[FEED] getPosts started");

    await authenticate(request, env);

    console.log("[FEED] authentication passed", {
      durationMs: Date.now() - feedStartedAt,
    });


    return await withFreshDatabase(

      env,

      async (db) => {

    console.log("[FEED] database ready", {
      durationMs: Date.now() - feedStartedAt,
    });

    const url = new URL(request.url);

    const page =
      Math.max(
        Number(url.searchParams.get("page")) || 1,
        1
      );

    const limit =
      Math.min(
        Number(url.searchParams.get("limit")) || 10,
        50
      );

    const posts = await db.collection("posts")
      .find(
        {},
        {
          projection: {
            _id: 1,
            user: 1,
            originalAuthor: 1,
            isSharedPost: 1,
            sharedFrom: 1,
            title: 1,
            content: 1,
            media: 1,
            type: 1,
            isReel: 1,
            feeling: 1,
            location: 1,
            textColor: 1,
            backgroundStyle: 1,
            fontStyle: 1,
            editor: 1,
            taggedFriends: 1,
            tags: 1,
            category: 1,
            shares: 1,
            pinned: 1,
            sponsored: 1,
            sponsor: 1,
            promotionBudget: 1,
            adClicks: 1,
            aiScore: 1,
            viralScore: 1,
            viral: 1,
            multiplier: 1,
            watchTime: 1,
            engagementPoints: 1,
            earnings: 1,
            viewsCount: 1,
            createdAt: 1,
            updatedAt: 1
          }
        }
      )
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    console.log("[FEED] posts query passed", {
      postsFound: posts.length,
      durationMs: Date.now() - feedStartedAt,
    });

    const populatedPosts =
      await populatePosts(db, posts);

    console.log("[FEED] populatePosts passed", {
      postsFound: populatedPosts.length,
      durationMs: Date.now() - feedStartedAt,
    });

    return json(populatedPosts);

      }

    );


  } catch (err) {
    console.error(
      "GET POSTS ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= GET USER POSTS ================= */

export async function getUserPosts(
  request,
  env,
  userId
) {
  try {
    await authenticate(request, env);

    if (!validId(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    return await withFreshDatabase(
      env,
      async (db) => {

    const posts = await db.collection("posts")
      .find({
        user: new ObjectId(userId),
      })
      .sort({ createdAt: -1 })
      .toArray();

        return json(
      await populatePosts(db, posts)
        );
      }
    );

  } catch (err) {
    console.error(
      "GET USER POSTS ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= TRENDING ================= */

export async function getTrending(
  request,
  env
) {
  try {
    await authenticate(request, env);

    const db = await getDatabase(env);
    const url = new URL(request.url);

    const page =
      Math.max(
        Number(url.searchParams.get("page")) || 1,
        1
      );

    const limit =
      Math.min(
        Number(url.searchParams.get("limit")) || 10,
        50
      );

    const posts = await db.collection("posts")
      .find(
        {},
        {
          projection: {
            _id: 1,
            user: 1,
            originalAuthor: 1,
            isSharedPost: 1,
            sharedFrom: 1,
            title: 1,
            content: 1,
            media: 1,
            type: 1,
            isReel: 1,
            feeling: 1,
            location: 1,
            textColor: 1,
            backgroundStyle: 1,
            fontStyle: 1,
            editor: 1,
            taggedFriends: 1,
            tags: 1,
            category: 1,
            shares: 1,
            pinned: 1,
            sponsored: 1,
            sponsor: 1,
            promotionBudget: 1,
            adClicks: 1,
            aiScore: 1,
            viralScore: 1,
            viral: 1,
            multiplier: 1,
            watchTime: 1,
            engagementPoints: 1,
            earnings: 1,
            viewsCount: 1,
            createdAt: 1,
            updatedAt: 1
          }
        }
      )
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    posts.sort((a, b) => {
      const scoreA =
        (Array.isArray(a.likes) ? a.likes.length : 0) * 3 +
        (Array.isArray(a.comments) ? a.comments.length : 0) * 2 +
        (a.viewsCount || 0);

      const scoreB =
        (Array.isArray(b.likes) ? b.likes.length : 0) * 3 +
        (Array.isArray(b.comments) ? b.comments.length : 0) * 2 +
        (b.viewsCount || 0);

      return scoreB - scoreA;
    });

    return json(
      await populatePosts(db, posts)
    );

  } catch (err) {
    console.error(
      "GET TRENDING ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= GET SINGLE POST ================= */

export async function getPost(
  request,
  env,
  postId
) {
  try {
    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);

    const post =
      await db.collection("posts").findOne({
        _id: new ObjectId(postId),
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    const populated =
      await populatePosts(db, [post]);

    return json(populated[0]);

  } catch (err) {
    console.error(
      "GET SINGLE POST ERROR:",
      err
    );

    return json({
      error: err.message,
    }, 500);
  }
}

/* ================= LIKE ================= */

export async function likePost(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const post =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    const likes = Array.isArray(post.likes)
      ? post.likes
      : [];

    const alreadyLiked =
      likes.some(
        id => String(id) === String(userId)
      );

    let newLikes;

    if (alreadyLiked) {
      newLikes = likes.filter(
        id => String(id) !== String(userId)
      );

      // This like existed before the new one-time
      // reward system. Mark it as already rewarded
      // so unlike/re-like cannot farm points.
      await markLikeRewarded(
        db,
        "posts",
        id,
        userId
      );
    } else {
      newLikes = [
        ...likes,
        userId,
      ];

      if (post.user) {
        const rewardClaimed =
          await claimLikeReward(
            db,
            "posts",
            id,
            userId
          );

        if (rewardClaimed) {
          await addPoints(
            db,
            post.user,
            1,
            post.isReel
              ? "reel_like"
              : "video_like"
          );
        }

        if (
          rewardClaimed &&
          String(post.user) !==
          String(userId)
        ) {
          await sendNotification(db, {
            recipient: post.user,
            sender: userId,
            type: "LIKE",
            text: "liked your post",
            post: id,
          });
        }
      }
    }

    await db.collection("posts").updateOne(
      { _id: id },
      {
        $set: {
          likes: newLikes,
          updatedAt: new Date(),
        },
      }
    );

    return json({
      likes: newLikes,
    });

  } catch (err) {
    console.error(
      "LIKE POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= SHARE ================= */

export async function sharePost(
  request,
  env,
  postId
) {
  try {
    await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const result =
      await db.collection("posts").findOneAndUpdate(
        { _id: id },
        {
          $inc: {
            shares: 1,
          },
          $set: {
            updatedAt: new Date(),
          },
        },
        {
          returnDocument: "after",
        }
      );

    if (!result) {
      return json({
        error: "Post not found",
      }, 404);
    }

    return json({
      shares: result.shares || 0,
    });

  } catch (err) {
    console.error(
      "SHARE POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= SAVE ================= */

export async function savePost(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const post =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    const savedBy =
      Array.isArray(post.savedBy)
        ? post.savedBy
        : [];

    const alreadySaved =
      savedBy.some(
        id => String(id) === String(userId)
      );

    if (alreadySaved) {
      await db.collection("posts").updateOne(
        { _id: id },
        {
          $pull: {
            savedBy: userId,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );
    } else {
      await db.collection("posts").updateOne(
        { _id: id },
        {
          $addToSet: {
            savedBy: userId,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );
    }

    const updated =
      await db.collection("posts").findOne({
        _id: id,
      });

    return json({
      success: true,
      saved: !alreadySaved,
      savedBy: updated.savedBy || [],
    });

  } catch (err) {
    console.error(
      "SAVE POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= EDIT ================= */

export async function editPost(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const post =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    if (
      String(post.user) !==
      String(userId)
    ) {
      return json({
        error: "Not authorized",
      }, 403);
    }

    const body = await request.json();

    const update = {
      updatedAt: new Date(),
    };

    if (body.content != null) {
      update.content = body.content;
    }

    if (body.media) {
      update.media = body.media;
    }

    if (body.editor) {
      update.editor = body.editor;
    }

    await db.collection("posts").updateOne(
      { _id: id },
      {
        $set: update,
      }
    );

    const updated =
      await db.collection("posts").findOne({
        _id: id,
      });

    const populated =
      await populatePosts(db, [updated]);

    return json({
      success: true,
      post: populated[0],
    });

  } catch (err) {
    console.error(
      "EDIT POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= DELETE ================= */

export async function deletePost(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const post =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    if (
      String(post.user) !==
      String(userId)
    ) {
      return json({
        error: "Not authorized",
      }, 403);
    }

    await db.collection("posts").deleteOne({
      _id: id,
    });

    return json({
      success: true,
    });

  } catch (err) {
    console.error(
      "DELETE POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= VIEW ================= */

export async function viewPost(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const post =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    const viewedBy =
      Array.isArray(post.viewedBy)
        ? post.viewedBy
        : [];

    const alreadyViewed =
      viewedBy.some(
        id => String(id) === String(userId)
      );

    if (!alreadyViewed) {
      const viewResult =
        await db.collection("posts").updateOne(
          {
            _id: id,
            viewedBy: {
              $nin: [
                userId,
                new ObjectId(userId),
              ],
            },
          },
          {
            $addToSet: {
              viewedBy: userId,
            },
            $inc: {
              viewsCount: 1,
            },
            $set: {
              updatedAt: new Date(),
            },
          }
        );

      if (
        viewResult.modifiedCount === 1 &&
        post.user
      ) {
        await addPoints(
          db,
          post.user,
          1,
          "video_view"
        );
      }
    }

    if (
      post.user &&
      String(post.user) !== String(userId)
    ) {
      await sendNotification(db, {
        recipient: post.user,
        sender: userId,
        type: "POST_VIEW",
        text: "viewed your post",
        post: id,
      });
    }

    return json({
      success: true,
    });

  } catch (err) {
    console.error(
      "VIEW POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= COMMENT ================= */

export async function commentPost(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const body = await request.json();
    const text = body.text;

    if (!text) {
      return json({
        error: "Comment text is required",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const post =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!post) {
      return json({
        error: "Post not found",
      }, 404);
    }

    const comment = {
      _id: new ObjectId(),
      user: userId,
      text,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection("posts").updateOne(
      { _id: id },
      {
        $push: {
          comments: comment,
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    const updated =
      await db.collection("posts").findOne({
        _id: id,
      });

    const populated =
      await populatePosts(db, [updated]);

    if (
      post.user &&
      String(post.user) !== String(userId)
    ) {
      await sendNotification(db, {
        recipient: post.user,
        sender: userId,
        type: "COMMENT",
        text: "commented on your post",
        post: id,
      });
    }

    return json({
      success: true,
      comments: populated[0].comments || [],
    });

  } catch (err) {
    console.error(
      "COMMENT POST ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= SAVED POSTS ================= */

export async function getSavedPosts(
  request,
  env
) {
  try {
    const userId =
      await authenticate(request, env);

    const db = await getDatabase(env);

    const posts = await db.collection("posts")
      .find({
        savedBy: userId,
      })
      .sort({ createdAt: -1 })
      .toArray();

    return json(
      await populatePosts(db, posts)
    );

  } catch (err) {
    console.error(
      "GET SAVED POSTS ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= SHARE TO FEED ================= */

export async function sharePostToFeed(
  request,
  env,
  postId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(postId)) {
      return json({
        error: "Invalid post ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(postId);

    const original =
      await db.collection("posts").findOne({
        _id: id,
      });

    if (!original) {
      return json({
        error: "Post not found",
      }, 404);
    }

    const newPost = {
      user: userId,
      content: original.content || "",
      media: original.media || [],
      sharedFrom: original._id,
      originalAuthor: original.user,
      isSharedPost: true,
      type: original.type || "text",
      likes: [],
      reactions: [],
      comments: [],
      shares: 0,
      savedBy: [],
      pinned: false,
      viewedBy: [],
      viewsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result =
      await db.collection("posts").insertOne(newPost);

    newPost._id = result.insertedId;

    if (
      original.user &&
      String(original.user) !== String(userId)
    ) {
      await sendNotification(db, {
        recipient: original.user,
        sender: userId,
        type: "SHARE",
        text: "shared your post",
        post: original._id,
      });
    }

    const populated =
      await populatePosts(db, [newPost]);

    return json({
      post: populated[0],
    });

  } catch (err) {
    console.error(
      "SHARE TO FEED ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= CREATE REEL ================= */

export async function createReel(
  request,
  env
) {
  try {
    const userId =
      await authenticate(request, env);

    const body = await request.json();

    const {
      caption,
      videoUrl,
      thumbnailUrl,
      durationSeconds,
    } = body;

    const duration = Number(durationSeconds);

    if (!Number.isFinite(duration) || duration <= 0) {
      return json({
        error: "Valid video duration is required",
      }, 400);
    }

    if (duration > 60) {
      return json({
        error: "Video exceeds 60 seconds",
      }, 400);
    }

    if (!videoUrl) {
      return json({
        error: "Video URL missing",
      }, 400);
    }

    const db = await getDatabase(env);

    const reel = {
      user: userId,
      content: caption || "",
      isReel: true,
      durationSeconds: duration,
      media: [
        {
          url: videoUrl,
          type: "video",
          thumbnailUrl: thumbnailUrl || "",
        },
      ],
      type: "video",
      likes: [],
      reactions: [],
      comments: [],
      shares: 0,
      savedBy: [],
      pinned: false,
      viewedBy: [],
      viewsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result =
      await db.collection("posts").insertOne(reel);

    reel._id = result.insertedId;

    const populated =
      await populatePosts(db, [reel]);

    return json(
      populated[0],
      201
    );

  } catch (err) {
    console.error(
      "CREATE REEL ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}

/* ================= GET REELS ================= */

export async function getReels(
  request,
  env
) {
  try {
    const url = new URL(request.url);

    const page =
      Math.max(
        Number(url.searchParams.get("page")) || 1,
        1
      );

    const limit = 5;

    console.log("[REELS] Before withDatabaseRetry");

return await withFreshDatabase(
  env,
  async (db) => {
        console.log("[REELS] Database received");

        console.log("[REELS] Starting posts query");

        const reels = await db.collection("posts")
          .find({
            isReel: true,
          })
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();

        console.log("[REELS] Posts query completed", {
          count: reels.length,
        });

        console.log("[REELS] Starting populatePosts");

        const populated = await populatePosts(db, reels);

        console.log("[REELS] populatePosts completed");

        return json(populated);
      }
    );

  } catch (err) {
    console.error(
      "GET REELS ERROR:",
      err
    );

    return json({
      error: err.message,
    }, 500);
  }
}
/* ================= REEL VIEW ================= */

export async function viewReel(
  request,
  env,
  reelId
) {
  try {
    const userId =
      await authenticate(request, env);

    if (!validId(reelId)) {
      return json({
        error: "Invalid reel ID",
      }, 400);
    }

    const db = await getDatabase(env);
    const id = new ObjectId(reelId);

    const reel =
      await db.collection("posts").findOne({
        _id: id,
        isReel: true,
      });

    if (!reel) {
      return json({
        error: "Reel not found",
      }, 404);
    }

    const viewedBy =
      Array.isArray(reel.viewedBy)
        ? reel.viewedBy
        : [];

    const alreadyViewed =
      viewedBy.some(
        id => String(id) === String(userId)
      );

    if (!alreadyViewed) {
      const viewResult =
        await db.collection("posts").updateOne(
          {
            _id: id,
            viewedBy: {
              $nin: [
                userId,
                new ObjectId(userId),
              ],
            },
          },
          {
            $addToSet: {
              viewedBy: userId,
            },
            $inc: {
              viewsCount: 1,
            },
            $set: {
              updatedAt: new Date(),
            },
          }
        );

      if (
        viewResult.modifiedCount === 1 &&
        reel.user
      ) {
        await addPoints(
          db,
          reel.user,
          1,
          "reel_view"
        );
      }
    }

    return json({
      success: true,
      views:
        (reel.viewsCount || 0) +
        (alreadyViewed ? 0 : 1),
    });

  } catch (err) {
    console.error(
      "VIEW REEL ERROR:",
      err
    );

    return json({
      error: isAuthError(err)
        ? err.message
        : err.message,
    }, isAuthError(err) ? 401 : 500);
  }
}
