import { ObjectId } from "mongodb";
import { withFreshDatabase } from "../utils/db.js";
import { authenticate } from "../utils/auth.js";
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

function isAuthError(err) {
  return [
    "Authentication required",
    "Invalid token",
    "Token expired",
    "Invalid authentication token",
    "Invalid user ID",
  ].includes(err.message);
}

/* ================= GET NOTIFICATIONS ================= */

export async function getNotifications(request, env) {
  try {
    const userId = await authenticate(request, env);
    return await withFreshDatabase(
      env,
      async (db) => {

    const notifications = await db.collection("notifications")
      .find({
        recipient: userId,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    /* ================= USERS ================= */

    const userIds = [];

    for (const notification of notifications) {
      if (notification.sender) {
        userIds.push(String(notification.sender));
      }

      if (Array.isArray(notification.senders)) {
        for (const senderId of notification.senders) {
          if (senderId) {
            userIds.push(String(senderId));
          }
        }
      }
    }

    const uniqueUserIds = [
      ...new Set(userIds),
    ].filter(id => ObjectId.isValid(id));

    let users = [];

    if (uniqueUserIds.length) {
      users = await db.collection("users")
        .find({
          _id: {
            $in: uniqueUserIds.map(
              id => new ObjectId(id)
            ),
          },
        })
        .project({
          name: 1,
          profilePic: 1,
          verified: 1,
        })
        .toArray();
    }

    const userMap = new Map(
      users.map(user => [
        String(user._id),
        user,
      ])
    );

    /* ================= POSTS ================= */

    const postIds = notifications
      .map(notification =>
        notification.post
          ? String(notification.post)
          : null
      )
      .filter(id => id && ObjectId.isValid(id));

    const uniquePostIds = [
      ...new Set(postIds),
    ];

    let posts = [];

    if (uniquePostIds.length) {
      posts = await db.collection("posts")
        .find({
          _id: {
            $in: uniquePostIds.map(
              id => new ObjectId(id)
            ),
          },
        })
        .project({
          content: 1,
          media: 1,
          images: 1,
          video: 1,
          thumbnail: 1,
          thumbnailUrl: 1,
          user: 1,
          createdAt: 1,
          visibility: 1,
          isSharedPost: 1,
          sharedFrom: 1,
        })
        .toArray();

      const access = createPostAccessChecker(db, userId);
      const visiblePosts = [];

      for (const post of posts) {
        if (await access.canViewPost(post)) {
          visiblePosts.push(post);
        }
      }

      posts = visiblePosts;
    }

    const postUserIds = posts
      .map(post =>
        post.user
          ? String(post.user)
          : null
      )
      .filter(id => id && ObjectId.isValid(id));

    const uniquePostUserIds = [
      ...new Set(postUserIds),
    ];

    let postUsers = [];

    if (uniquePostUserIds.length) {
      postUsers = await db.collection("users")
        .find({
          _id: {
            $in: uniquePostUserIds.map(
              id => new ObjectId(id)
            ),
          },
        })
        .project({
          name: 1,
          profilePic: 1,
          verified: 1,
        })
        .toArray();
    }

    const postUserMap = new Map(
      postUsers.map(user => [
        String(user._id),
        user,
      ])
    );

    const postMap = new Map();

    for (const post of posts) {
      const populatedPost = {
        ...post,
      };

      if (post.user) {
        populatedPost.user =
          postUserMap.get(
            String(post.user)
          ) || post.user;
      }

      postMap.set(
        String(post._id),
        populatedPost
      );
    }

    /* ================= FINAL RESPONSE ================= */

    const result = notifications.map(
      notification => {
        const item = {
          ...notification,
        };

        /* sender */

        if (notification.sender) {
          item.sender =
            userMap.get(
              String(notification.sender)
            ) || notification.sender;
        }

        /* senders */

        if (
          Array.isArray(notification.senders)
        ) {
          item.senders =
            notification.senders.map(
              senderId =>
                userMap.get(
                  String(senderId)
                ) || senderId
            );
        }

        /* post */

        if (notification.post) {
          item.post =
            postMap.get(
              String(notification.post)
            ) || notification.post;
        }

        return item;
      }
    );

        return json(result);
      }
    );

  } catch (err) {
    console.error(
      "GET NOTIFICATIONS ERROR:",
      err
    );

    return json(
      {
        error: isAuthError(err)
          ? err.message
          : "Server error",
      },
      isAuthError(err) ? 401 : 500
    );
  }
}

/* ================= MARK READ ================= */

export async function markNotificationsRead(
  request,
  env
) {
  try {
    const userId =
      await authenticate(request, env);

    return await withFreshDatabase(
      env,
      async (db) => {
        await db.collection("notifications")
      .updateMany(
        {
          recipient: userId,
          read: false,
        },
        {
          $set: {
            read: true,
          },
        }
      );

        return json({
          message:
            "Notifications marked as read",
        });
      }
    );

  } catch (err) {
    console.error(
      "MARK NOTIFICATIONS READ ERROR:",
      err
    );

    return json(
      {
        error: isAuthError(err)
          ? err.message
          : "Server error",
      },
      isAuthError(err) ? 401 : 500
    );
  }
}

/* ================= UNREAD COUNT ================= */

export async function getUnreadNotificationCount(
  request,
  env
) {
  try {
    const userId =
      await authenticate(request, env);

    return await withFreshDatabase(
      env,
      async (db) => {

    const count =
      await db.collection("notifications")
        .countDocuments({
          recipient: userId,
          read: false,
        });

        return json({
          count,
        });
      }
    );

  } catch (err) {
    console.error(
      "UNREAD COUNT ERROR:",
      err
    );

    return json(
      {
        error: isAuthError(err)
          ? err.message
          : "Server error",
      },
      isAuthError(err) ? 401 : 500
    );
  }
}
