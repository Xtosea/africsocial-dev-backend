import { ObjectId } from "mongodb";
import { getDatabase, debugDbOperation, withFreshDatabase } from "../utils/db.js";
import { authenticate } from "../utils/auth.js";
import { getStoryMediaKeys, isOwnedStoryMediaKey } from "../utils/storyMedia.js";
import { createPostAccessChecker } from "../utils/postAccess.js";

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

function validId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
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
  "stories.populate.users",
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

async function filterVisibleStories(db, stories, viewerId) {
  const access = createPostAccessChecker(db, viewerId);
  const visible = [];

  for (const story of stories) {
    const canView = await access.canViewPost({
      _id: story._id,
      user: story.user,
      visibility: story.visibility || "public",
      isSharedPost: false,
    });

    if (canView) visible.push(story);
  }

  return visible;
}

async function populateStories(db, stories) {
  if (!stories.length) return stories;

  const userIds = [];

  for (const story of stories) {
    if (story.user) userIds.push(story.user);

    if (Array.isArray(story.views)) {
      userIds.push(...story.views);
    }

    if (Array.isArray(story.reactions)) {
      for (const reaction of story.reactions) {
        if (reaction.user) userIds.push(reaction.user);
      }
    }

    if (Array.isArray(story.replies)) {
      for (const reply of story.replies) {
        if (reply.user) userIds.push(reply.user);
      }
    }
  }

  const userMap = await getUsersMap(db, userIds);

  return stories.map(story => {
    const result = { ...story };

    if (story.user) {
      result.user =
        userMap.get(String(story.user)) || story.user;
    }

    if (Array.isArray(story.views)) {
      result.views = story.views.map(id =>
        userMap.get(String(id)) || id
      );
    }

    if (Array.isArray(story.reactions)) {
      result.reactions = story.reactions.map(reaction => ({
        ...reaction,
        user: reaction.user
          ? userMap.get(String(reaction.user)) || reaction.user
          : reaction.user,
      }));
    }

    if (Array.isArray(story.replies)) {
      result.replies = story.replies.map(reply => ({
        ...reply,
        user: reply.user
          ? userMap.get(String(reply.user)) || reply.user
          : reply.user,
      }));
    }

    return result;
  });
}

/* ================= POINTS ================= */

async function addPoints(db, userId, amount, type) {
  if (!userId || !amount) return;

  const fieldMap = {
    story_like: "storyLikes",
    story_view: "storyViews",
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

async function sendNotification(
  db,
  {
    recipient,
    sender,
    type,
    text,
  }
) {
  if (!recipient) return;

  const recipientId = new ObjectId(recipient);

  const senderId =
    sender && ObjectId.isValid(String(sender))
      ? new ObjectId(sender)
      : undefined;

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

  await db.collection("notifications").insertOne(
    notification
  );
}

/* ================= CREATE STORY ================= */


export async function createStory(request, env) {
  try {
    const userId = await authenticate(request, env);
    const body = await request.json();

    const {
      media = [],
      caption = "",
      text = "",
      textStyle = {},
      music = null,
      stickers = [],
      backgroundColor = "#000000",
      visibility = "public",
    } = body;

    if (!["public", "friends", "private"].includes(visibility)) {
      return json({ error: "Invalid Story visibility" }, 400);
    }

    if (
      (!Array.isArray(media) || media.length === 0) &&
      !text &&
      !music &&
      (!Array.isArray(stickers) || stickers.length === 0)
    ) {
      return json({
        error: "Story must contain media, text, music, or stickers",
      }, 400);
    }

    const storyMedia = Array.isArray(media) ? media : [];

    const hasInvalidR2Key = getStoryMediaKeys(storyMedia).some(
      (key) => !isOwnedStoryMediaKey(key, String(userId))
    );

    if (hasInvalidR2Key) {
      return json({
        error: "Invalid Story media storage key",
      }, 400);
    }

    const db = await getDatabase(env);
    const now = new Date();

    const story = {
      user: new ObjectId(userId),
      visibility,
      media: storyMedia,
      caption,
      text,
      textStyle: {
        x: textStyle.x ?? 100,
        y: textStyle.y ?? 100,
        fontSize: textStyle.fontSize ?? 24,
        color: textStyle.color ?? "#ffffff",
        rotation: textStyle.rotation ?? 0,
      },
      music,
      stickers: Array.isArray(stickers) ? stickers : [],
      backgroundColor,
      views: [],
      viewsCount: 0,
      reactions: [],
      replies: [],
      shares: 0,
      engagementPoints: 0,
      expiresAt: new Date(
        now.getTime() + 24 * 60 * 60 * 1000
      ),
      createdAt: now,
      updatedAt: now,
    };

    const result =
      await db.collection("stories").insertOne(story);

    story._id = result.insertedId;

    const populated =
      await populateStories(db, [story]);

    return json(populated[0], 201);

  } catch (err) {
    console.error("CREATE STORY ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to create story",
    }, 500);
  }
}

export async function getStoryFeed(request, env, dependencies = {}) {
  try {
    const authenticateUser = dependencies.authenticate || authenticate;
    const databaseProvider = dependencies.getDatabase || getDatabase;
    const viewerId = await authenticateUser(request, env);
    const db = await databaseProvider(env);

    const stories =
      await debugDbOperation(
        "stories.feed",
        () =>
          db.collection("stories")
            .find({
              expiresAt: {
                $gt: new Date(),
              },
            })
            .sort({
              createdAt: -1,
            })
            .toArray()
      );

    const visibleStories =
      await filterVisibleStories(db, stories, viewerId);

    const populated =
      await populateStories(db, visibleStories);

    return json(populated);

  } catch (err) {
    console.error("GET STORIES ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to fetch stories",
    }, 500);
  }
}

export async function getStories(request, env, dependencies = {}) {
  try {
    const authenticateUser = dependencies.authenticate || authenticate;
    const freshDatabaseProvider = dependencies.withFreshDatabase || withFreshDatabase;
    const viewerId = await authenticateUser(request, env);
    return await freshDatabaseProvider(
      env,
      async (db) => {

    const stories =
      await debugDbOperation(
        "stories.get",
        () =>
          db.collection("stories")
            .find({
              expiresAt: {
                $gt: new Date(),
              },
            })
            .sort({
              createdAt: -1,
            })
            .toArray()
      );

    const visibleStories =
      await filterVisibleStories(db, stories, viewerId);

    const populated =
      await populateStories(db, visibleStories);

    return json(populated);
      }
    );

  } catch (err) {
    console.error("GET STORIES ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to fetch stories",
    }, 500);
  }
}

/* ================= VIEW STORY ================= */

export async function viewStory(request, env, dependencies = {}) {
  try {
    const authenticateUser = dependencies.authenticate || authenticate;
    const databaseProvider = dependencies.getDatabase || getDatabase;
    const awardPoints = dependencies.addPoints || addPoints;
    const notify = dependencies.sendNotification || sendNotification;
    const userId = await authenticateUser(request, env);

    const storyId =
      new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({
        error: "Invalid story ID",
      }, 400);
    }

    const db = await databaseProvider(env);

    const story =
      await db.collection("stories").findOne({
        _id: new ObjectId(storyId),
        expiresAt: { $gt: new Date() },
      });

    if (!story) {
      return json({
        error: "Story not found",
      }, 404);
    }

    const access = createPostAccessChecker(db, userId);
    const canView = await access.canViewPost({
      _id: story._id,
      user: story.user,
      visibility: story.visibility || "public",
      isSharedPost: false,
    });

    if (!canView) {
      return json({
        error: "Story not found",
      }, 404);
    }

    const views =
      Array.isArray(story.views)
        ? story.views
        : [];

    const alreadyViewed =
      views.some(
        id => String(id) === String(userId)
      );

    if (!alreadyViewed) {
      const viewResult =
        await db.collection("stories").updateOne(
          {
            _id: story._id,
            views: {
              $nin: [
                new ObjectId(userId),
                String(userId),
              ],
            },
          },
          {
            $addToSet: {
              views: new ObjectId(userId),
            },
            $inc: {
              viewsCount: 1,
              engagementPoints: 1,
            },
            $set: {
              updatedAt: new Date(),
            },
          }
        );

      if (viewResult.modifiedCount === 1) {
        await awardPoints(
          db,
          story.user,
          1,
          "story_view"
        );

        if (
          String(story.user) !==
          String(userId)
        ) {
          await notify(db, {
            recipient: story.user,
            sender: userId,
            type: "STORY_VIEW",
            text: "viewed your story",
          });
        }
      }
    }

    const updated =
      await db.collection("stories").findOne({
        _id: story._id,
      });

    return json({
      success: true,
      viewsCount: updated?.viewsCount || 0,
    });

  } catch (err) {
    console.error("VIEW STORY ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to view story",
    }, 500);
  }
}

/* ================= REACT TO STORY ================= */

export async function reactToStory(request, env) {
  try {
    const userId = await authenticate(request, env);

    const storyId =
      new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({
        error: "Invalid story ID",
      }, 400);
    }

    const body = await request.json();
    const reaction = body.reaction;

    if (!reaction) {
      return json({
        error: "Reaction is required",
      }, 400);
    }

    const allowedReactions = [
      "❤️",
      "😂",
      "😮",
      "😢",
      "👍",
    ];

    if (!allowedReactions.includes(reaction)) {
      return json({
        error: "Invalid reaction",
      }, 400);
    }

    const db = await getDatabase(env);

    const story =
      await db.collection("stories").findOne({
        _id: new ObjectId(storyId),
      });

    if (!story) {
      return json({
        error: "Story not found",
      }, 404);
    }

    const reactions =
      Array.isArray(story.reactions)
        ? story.reactions
        : [];

    const existingIndex =
      reactions.findIndex(
        item =>
          item.user &&
          String(item.user) === String(userId)
      );

    const wasFirstReaction =
      existingIndex === -1;

    const newReactions =
      existingIndex >= 0
        ? reactions.filter(
            (_, index) => index !== existingIndex
          )
        : reactions.slice();

    newReactions.push({
      user: new ObjectId(userId),
      type: reaction,
    });

    await db.collection("stories").updateOne(
      { _id: story._id },
      {
        $set: {
          reactions: newReactions,
          updatedAt: new Date(),
        },
      }
    );

    if (wasFirstReaction) {
      const rewardClaimed =
        await claimLikeReward(
          db,
          "stories",
          story._id,
          userId
        );

      if (rewardClaimed) {
        await addPoints(
          db,
          story.user,
          1,
          "story_like"
        );
      }

      if (
        rewardClaimed &&
        String(story.user) !==
        String(userId)
      ) {
        await sendNotification(db, {
          recipient: story.user,
          sender: userId,
          type: "STORY_LIKE",
          text: "reacted to your story",
        });
      }
    }

    return json({
      success: true,
      reactions: newReactions,
    });

  } catch (err) {
    console.error("REACT STORY ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to react to story",
    }, 500);
  }
}

/* ================= SHARE STORY ================= */

export async function shareStory(request, env, dependencies = {}) {
  let db;
  let storyId;
  let reservationToken;
  let reservationAcquired = false;

  try {
    const authenticateUser = dependencies.authenticate || authenticate;
    const databaseProvider = dependencies.getDatabase || getDatabase;

    const userId = await authenticateUser(request, env);
    storyId = new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({ error: "Invalid story ID" }, 400);
    }

    db = await databaseProvider(env);

    const stories = db.collection("stories");
    const now = new Date();

    reservationToken = crypto.randomUUID();

    const reservationExpiry = new Date(
      now.getTime() + 10 * 60 * 1000
    );

    // Atomically reserve the active Story.
    // Sharing is blocked if cleanup has already claimed it.
    const reservation = await stories.updateOne(
      {
        _id: new ObjectId(storyId),
        expiresAt: { $gt: now },
        $or: [
          { "cleanupLease.expiresAt": { $exists: false } },
          { "cleanupLease.expiresAt": { $lte: now } },
        ],
      },
      {
        $push: {
          shareReservations: {
            token: reservationToken,
            expiresAt: reservationExpiry,
          },
        },
      }
    );

    if (reservation.modifiedCount !== 1) {
      const existingStory = await stories.findOne(
        { _id: new ObjectId(storyId) },
        { projection: { _id: 1, expiresAt: 1 } }
      );

      if (
        !existingStory ||
        !existingStory.expiresAt ||
        new Date(existingStory.expiresAt) <= now
      ) {
        return json({ error: "Story not found or has expired" }, 404);
      }

      return json({
        error: "Story cleanup is in progress. Please try again.",
      }, 409);
    }

    reservationAcquired = true;

    const story = await stories.findOne({
      _id: new ObjectId(storyId),
      expiresAt: { $gt: new Date() },
      "shareReservations.token": reservationToken,
    });

    if (!story) {
      return json({ error: "Story is no longer available" }, 404);
    }

    const access = createPostAccessChecker(db, userId);
    const canViewStory = await access.canViewPost({
      _id: story._id,
      user: story.user,
      visibility: story.visibility || "public",
      isSharedPost: false,
    });

    if (!canViewStory) {
      return json({ error: "Story not found" }, 404);
    }

    const post = {
      user: new ObjectId(userId),
      content: story.caption || "Shared a story",
      media: story.media || [],
      sharedFrom: story._id,
      sharedFromType: "story",
      originalAuthor: story.user,
      isSharedPost: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("posts").insertOne(post);
    post._id = result.insertedId;

    await stories.updateOne(
      { _id: story._id },
      {
        $inc: {
          shares: 1,
          engagementPoints: 3,
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    return json({ success: true, post });
  } catch (err) {
    console.error("SHARE STORY ERROR:", err);

    if (isAuthError(err)) {
      return json({ error: err.message }, 401);
    }

    return json({
      error: err.message || "Share failed",
    }, 500);
  } finally {
    if (reservationAcquired && db && storyId && reservationToken) {
      try {
        await db.collection("stories").updateOne(
          { _id: new ObjectId(storyId) },
          {
            $pull: {
              shareReservations: {
                token: reservationToken,
              },
            },
          }
        );
      } catch (releaseError) {
        console.error(
          "[STORY SHARE] Failed to release reservation:",
          releaseError
        );
      }
    }
  }
}

/* ================= REPLY TO STORY ================= */

export async function replyToStory(request, env) {
  try {
    const userId = await authenticate(request, env);

    const storyId =
      new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({
        error: "Invalid story ID",
      }, 400);
    }

    const body = await request.json();
    const text = body.text;

    if (!text || !text.trim()) {
      return json({
        error: "Reply text is required",
      }, 400);
    }

    const db = await getDatabase(env);

    const story =
      await db.collection("stories").findOne({
        _id: new ObjectId(storyId),
      });

    if (!story) {
      return json({
        error: "Story not found",
      }, 404);
    }

    const reply = {
      user: new ObjectId(userId),
      text: text.trim(),
      createdAt: new Date(),
    };

    await db.collection("stories").updateOne(
      { _id: story._id },
      {
        $push: {
          replies: reply,
        },
        $inc: {
          engagementPoints: 3,
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    await sendNotification(db, {
      recipient: story.user,
      sender: userId,
      type: "COMMENT",
      text: "replied to your story",
    });

    return json({
      success: true,
      reply,
    });

  } catch (err) {
    console.error("REPLY STORY ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to reply to story",
    }, 500);
  }
}

/* ================= ANALYTICS ================= */

export async function getStoryAnalytics(request, env) {
  try {
    const userId = await authenticate(request, env);

    const storyId =
      new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({
        error: "Invalid story ID",
      }, 400);
    }

    const db = await getDatabase(env);

    const story =
      await db.collection("stories").findOne({
        _id: new ObjectId(storyId),
      });

    if (!story) {
      return json({
        error: "Story not found",
      }, 404);
    }

    if (
      !story.user ||
      String(story.user) !== String(userId)
    ) {
      return json({
        error: "Not authorized",
      }, 403);
    }

    const reactionSummary = {
      "❤️": 0,
      "😂": 0,
      "😮": 0,
      "😢": 0,
      "👍": 0,
      "🔥": 0,
    };

    const reactions =
      Array.isArray(story.reactions)
        ? story.reactions
        : [];

    for (const reaction of reactions) {
      if (reactionSummary[reaction.type] !== undefined) {
        reactionSummary[reaction.type]++;
      }
    }

    const replies =
      Array.isArray(story.replies)
        ? story.replies
        : [];

    const views =
      Array.isArray(story.views)
        ? story.views
        : [];

    const shares =
      Number(story.shares || 0);

    const totalReactions =
      reactions.length;

    const totalReplies =
      replies.length;

    const engagementScore =
      totalReactions +
      totalReplies * 2 +
      shares * 3;

    const viewsCount =
      Number(story.viewsCount || 0);

    const engagementRate =
      viewsCount > 0
        ? Number(
            (engagementScore / viewsCount).toFixed(2)
          )
        : 0;

    const viralScore =
      engagementScore +
      viewsCount * 0.1;

    const populated =
      await populateStories(db, [story]);

    const populatedStory =
      populated[0];

    return json({
      views: viewsCount,
      totalViewers: views.length,
      reactions: reactionSummary,
      totalReactions,
      replies: totalReplies,
      shares,
      engagementScore,
      engagementRate,
      viralScore,
      engagementPoints:
        Number(story.engagementPoints || 0),
      viewers:
        populatedStory.views || [],
      repliesList:
        populatedStory.replies || [],
      createdAt: story.createdAt,
    });

  } catch (err) {
    console.error("STORY ANALYTICS ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to get story analytics",
    }, 500);
  }
}

/* ================= LIKE STORY ================= */

export async function likeStory(request, env) {
  try {
    const userId = await authenticate(request, env);

    const storyId =
      new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({
        error: "Invalid story ID",
      }, 400);
    }

    const db = await getDatabase(env);

    const story =
      await db.collection("stories").findOne({
        _id: new ObjectId(storyId),
      });

    if (!story) {
      return json({
        error: "Story not found",
      }, 404);
    }

    const uid = new ObjectId(userId);

    const likes =
      Array.isArray(story.likes)
        ? story.likes
        : [];

    const alreadyLiked =
      likes.some(
        id => String(id) === String(userId)
      );

    if (alreadyLiked) {
      const newLikes = likes.filter(
        id => String(id) !== String(userId)
      );

      await db.collection("stories").updateOne(
        { _id: story._id },
        {
          $set: {
            likes: newLikes,
            updatedAt: new Date(),
          },
          $addToSet: {
            likeRewardedBy: uid,
          },
        }
      );
    } else {
      const newLikes = [
        ...likes,
        uid,
      ];

      await db.collection("stories").updateOne(
        { _id: story._id },
        {
          $set: {
            likes: newLikes,
            updatedAt: new Date(),
          },
        }
      );

      const rewardClaimed =
        await claimLikeReward(
          db,
          "stories",
          story._id,
          userId
        );

      if (rewardClaimed) {
        await addPoints(
          db,
          story.user,
          1,
          "story_like"
        );

        if (
          String(story.user) !==
          String(userId)
        ) {
          await sendNotification(db, {
            recipient: story.user,
            sender: userId,
            type: "STORY_LIKE",
            text: "liked your story",
          });
        }
      }
    }

    const updated =
      await db.collection("stories").findOne({
        _id: story._id,
      });

    return json(updated);

  } catch (err) {
    console.error("LIKE STORY ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error:
        err.message ||
        "Failed to like story",
    }, 500);
  }
}

/* ================= SIMPLE VIEW STORY ================= */

export async function markStoryViewed(request, env) {
  try {
    const userId = await authenticate(request, env);

    const storyId =
      new URL(request.url).pathname.split("/").pop();

    if (!validId(storyId)) {
      return json({
        error: "Invalid story ID",
      }, 400);
    }

    const db = await getDatabase(env);

    const story =
      await db.collection("stories").findOne({
        _id: new ObjectId(storyId),
      });

    if (!story) {
      return json({
        error: "Story not found",
      }, 404);
    }

    const views =
      Array.isArray(story.views)
        ? story.views
        : [];

    if (
      !views.some(
        id => String(id) === String(userId)
      )
    ) {
      const viewResult =
        await db.collection("stories").updateOne(
          {
            _id: story._id,
            views: {
              $nin: [
                new ObjectId(userId),
                String(userId),
              ],
            },
          },
          {
            $addToSet: {
              views: new ObjectId(userId),
            },
            $set: {
              updatedAt: new Date(),
            },
          }
        );

      if (viewResult.modifiedCount === 1) {
        await addPoints(
          db,
          story.user,
          1,
          "story_view"
        );
      }
    }

    return json({
      success: true,
    });

  } catch (err) {
    console.error("MARK STORY VIEW ERROR:", err);

    if (isAuthError(err)) {
      return json({
        error: err.message,
      }, 401);
    }

    return json({
      error: err.message || "Failed to mark story viewed",
    }, 500);
  }
}
