import { ObjectId } from "mongodb";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/* ================= TOKEN ================= */

function getToken(request) {
  const authorization = request.headers.get("Authorization");

  if (!authorization) return null;

  const parts = authorization.trim().split(/\s+/);

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
}

/* ================= BASE64URL ================= */

function base64UrlDecode(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded =
    base64 +
    "=".repeat((4 - (base64.length % 4)) % 4);

  return atob(padded);
}

/* ================= VERIFY JWT ================= */

async function verifyJWT(token, secret) {
  if (!token) {
    throw new Error("Authentication required");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid token");
  }

  const [
    encodedHeader,
    encodedPayload,
    encodedSignature,
  ] = parts;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  const signature = Uint8Array.from(
    base64UrlDecode(encodedSignature),
    char => char.charCodeAt(0)
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
    throw new Error("Invalid token");
  }

  const payload = JSON.parse(
    base64UrlDecode(encodedPayload)
  );

  if (
    payload.exp &&
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Token expired");
  }

  return payload;
}

/* ================= AUTH ================= */

async function authenticate(request, env) {
  if (!env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  const token = getToken(request);

  const payload = await verifyJWT(
    token,
    env.JWT_SECRET
  );

  if (!payload.id) {
    throw new Error("Invalid authentication token");
  }

  if (!ObjectId.isValid(payload.id)) {
    throw new Error("Invalid user ID");
  }

  return new ObjectId(payload.id);
}

/* ================= PUBLIC USER ================= */

function cleanUser(user) {
  if (!user) return null;

  const {
    password,
    verifyToken,
    verifyTokenExpiry,
    resetToken,
    resetTokenExpiry,
    ...safeUser
  } = user;

  return {
    ...safeUser,
    _id: user._id,
    email: user.email || "",
    phone: user.phone || "",
    profilePic: user.profilePic || "",
    coverPhoto: user.coverPhoto || "",
    bio: user.bio || "",
    intro: user.intro || "",
    followers: user.followers || [],
    following: user.following || [],
    friends: user.friends || [],
  };
}

/* ================= POPULATE USERS ================= */

async function populateUsers(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const validIds = ids
    .filter(id => ObjectId.isValid(id))
    .map(id =>
      id instanceof ObjectId
        ? id
        : new ObjectId(id)
    );

  if (!validIds.length) {
    return [];
  }

  return await db
    .collection("users")
    .find({
      _id: { $in: validIds },
    })
    .project({
      _id: 1,
      name: 1,
      profilePic: 1,
      coverPhoto: 1,
      bio: 1,
      intro: 1,
    })
    .toArray();
}

/* ================= GET ALL USERS ================= */

export async function getUsers(
  request,
  env,
  db
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    const users = await db
      .collection("users")
      .find({
        _id: { $ne: currentUserId },
      })
      .project({
        _id: 1,
        name: 1,
        profilePic: 1,
        intro: 1,
      })
      .toArray();

    return json(users);

  } catch (error) {
    console.error(
      "GET USERS ERROR:",
      error
    );

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= GET USER PROFILE ================= */

export async function getUser(
  request,
  env,
  db,
  userId
) {
  try {
    if (!ObjectId.isValid(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    const user = await db
      .collection("users")
      .findOne({
        _id: new ObjectId(userId),
      });

    if (!user) {
      return json({
        error: "User not found",
      }, 404);
    }

    const result = cleanUser(user);

    result.followers =
      await populateUsers(
        db,
        user.followers || []
      );

    result.following =
      await populateUsers(
        db,
        user.following || []
      );

    result.friends =
      await populateUsers(
        db,
        user.friends || []
      );

    return json(result);

  } catch (error) {
    console.error(
      "GET USER ERROR:",
      {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || "No stack",
        userId,
      }
    );

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= FOLLOWERS ================= */

export async function getFollowers(
  request,
  env,
  db,
  userId
) {
  try {
    if (!ObjectId.isValid(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    const user = await db
      .collection("users")
      .findOne(
        {
          _id: new ObjectId(userId),
        },
        {
          projection: {
            followers: 1,
          },
        }
      );

    if (!user) {
      return json({
        followers: [],
      });
    }

    const followers =
      await populateUsers(
        db,
        user.followers || []
      );

    return json({
      followers,
    });

  } catch (error) {
    console.error(
      "GET FOLLOWERS ERROR:",
      error
    );

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= FOLLOWING ================= */

export async function getFollowing(
  request,
  env,
  db,
  userId
) {
  try {
    if (!ObjectId.isValid(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    const user = await db
      .collection("users")
      .findOne(
        {
          _id: new ObjectId(userId),
        },
        {
          projection: {
            following: 1,
          },
        }
      );

    if (!user) {
      return json({
        following: [],
      });
    }

    const following =
      await populateUsers(
        db,
        user.following || []
      );

    return json({
      following,
    });

  } catch (error) {
    console.error(
      "GET FOLLOWING ERROR:",
      error
    );

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= MUTUAL FRIENDS ================= */

export async function getMutualFriends(
  request,
  env,
  db,
  userId
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    if (!ObjectId.isValid(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    const otherUserId =
      new ObjectId(userId);

    const [
      currentUser,
      otherUser,
    ] = await Promise.all([
      db.collection("users").findOne(
        {
          _id: currentUserId,
        },
        {
          projection: {
            following: 1,
          },
        }
      ),

      db.collection("users").findOne(
        {
          _id: otherUserId,
        },
        {
          projection: {
            following: 1,
          },
        }
      ),
    ]);

    if (!currentUser || !otherUser) {
      return json({
        error: "User not found",
      }, 404);
    }

    const currentFollowing =
      (currentUser.following || [])
        .map(id => id.toString());

    const otherFollowing =
      (otherUser.following || [])
        .map(id => id.toString());

    const mutualIds =
      currentFollowing.filter(id =>
        otherFollowing.includes(id)
      );

    if (!mutualIds.length) {
      return json([]);
    }

    const mutualUsers =
      await populateUsers(
        db,
        mutualIds
      );

    return json(mutualUsers);

  } catch (error) {
    console.error(
      "GET MUTUAL FRIENDS ERROR:",
      error
    );

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= FOLLOW / UNFOLLOW ================= */

export async function toggleFollow(
  request,
  env,
  db,
  userId
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    if (!ObjectId.isValid(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    const targetUserId =
      new ObjectId(userId);

    if (
      currentUserId.toString() ===
      targetUserId.toString()
    ) {
      return json({
        error: "Cannot follow yourself",
      }, 400);
    }

    const users =
      await db.collection("users")
        .find({
          _id: {
            $in: [
              currentUserId,
              targetUserId,
            ],
          },
        })
        .toArray();

    const currentUser =
      users.find(
        user =>
          user._id.toString() ===
          currentUserId.toString()
      );

    const userToFollow =
      users.find(
        user =>
          user._id.toString() ===
          targetUserId.toString()
      );

    if (!userToFollow) {
      return json({
        error: "User not found",
      }, 404);
    }

    if (!currentUser) {
      return json({
        error: "Current user not found",
      }, 404);
    }

    const following =
      (currentUser.following || [])
        .map(id => id.toString());

    const isFollowing =
      following.includes(
        targetUserId.toString()
      );

    let action;
    let points =
      typeof currentUser.points === "number"
        ? currentUser.points
        : 0;

    if (isFollowing) {
      await db.collection("users").updateOne(
        { _id: currentUserId },
        {
          $pull: {
            following: targetUserId,
          },
          $inc: {
            points: -5,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );

      await db.collection("users").updateOne(
        { _id: targetUserId },
        {
          $pull: {
            followers: currentUserId,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );

      points -= 5;
      action = "UNFOLLOW";

    } else {
      await db.collection("users").updateOne(
        { _id: currentUserId },
        {
          $addToSet: {
            following: targetUserId,
          },
          $inc: {
            points: 10,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );

      await db.collection("users").updateOne(
        { _id: targetUserId },
        {
          $addToSet: {
            followers: currentUserId,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );

      points += 10;
      action = "FOLLOW";

      await db.collection("notifications").insertOne({
        recipient: targetUserId,
        sender: currentUserId,
        senders: [currentUserId],
        count: 1,
        type: "FOLLOW",
        text: `${currentUser.name} started following you`,
        post: null,
        read: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    return json({
      message: "Action successful",
      points,
      action,
    });

  } catch (error) {
    console.error(
      "FOLLOW ERROR:",
      error
    );

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= UPDATE PROFILE ================= */

export async function updateUser(
  request,
  env,
  db,
  userId
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    if (!ObjectId.isValid(userId)) {
      return json({
        error: "Invalid user ID",
      }, 400);
    }

    const targetUserId =
      new ObjectId(userId);

    if (
      currentUserId.toString() !==
      targetUserId.toString()
    ) {
      return json({
        error: "Unauthorized",
      }, 403);
    }

    const body =
      await request.json();

    const allowedFields = [
      "name",
      "bio",
      "intro",
      "dob",
      "phone",
      "education",
      "origin",
      "maritalStatus",
      "spouse",
      "gender",
      "email",
      "hubby",
      "profilePic",
      "coverPhoto",
      "isPrivate",
    ];

    if (
      Object.prototype.hasOwnProperty.call(body, "isPrivate") &&
      typeof body.isPrivate !== "boolean"
    ) {
      return json({ error: "isPrivate must be a Boolean" }, 400);
    }

    const updates = {};

    for (const field of allowedFields) {
      if (
        Object.prototype.hasOwnProperty.call(
          body,
          field
        )
      ) {
        updates[field] = body[field];
      }
    }

    if (
      typeof updates.name === "string"
    ) {
      updates.name =
        updates.name.trim();
    }

    if (
      typeof updates.email === "string"
    ) {
      updates.email =
        updates.email
          .trim()
          .toLowerCase();
    }

    if (
      typeof updates.phone === "string"
    ) {
      updates.phone =
        updates.phone.trim();
    }

    updates.updatedAt = new Date();

    await db.collection("users").updateOne(
      {
        _id: targetUserId,
      },
      {
        $set: updates,
      }
    );

    const updatedUser =
      await db.collection("users").findOne({
        _id: targetUserId,
      });

    if (!updatedUser) {
      return json({
        error: "User not found",
      }, 404);
    }

    return json(
      cleanUser(updatedUser)
    );

  } catch (error) {
    console.error(
      "UPDATE USER ERROR:",
      error
    );

    if (
      error.code === 11000
    ) {
      return json({
        error:
          "Email or phone number already exists",
      }, 400);
    }

    return json({
      error: error.message,
    }, 500);
  }
}
