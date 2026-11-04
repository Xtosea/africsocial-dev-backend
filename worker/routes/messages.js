import { ObjectId } from "mongodb";
import { authenticate } from "../utils/auth.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
    },
  });
}

function getErrorStatus(error) {
  const authErrors = [
    "Authentication required",
    "Invalid token",
    "Token expired",
    "Invalid authentication token",
    "Invalid user ID",
  ];

  if (
    authErrors.includes(error?.message) ||
    error?.name === "InvalidCharacterError"
  ) {
    return 401;
  }

  return 500;
}

/* ================= SEND MESSAGE ================= */

export async function sendMessage(
  request,
  env,
  db
) {
  try {
    const senderId =
      await authenticate(request, env);

    const body = await request.json();

    const {
      receiver,
      text,
      media,
      mediaType,
    } = body || {};

    if (!receiver) {
      return json({
        error: "Receiver is required",
      }, 400);
    }

    if (!ObjectId.isValid(receiver)) {
      return json({
        error: "Invalid receiver ID",
      }, 400);
    }

    const receiverId =
      new ObjectId(receiver);

    const receiverUser =
      await db.collection("users").findOne({
        _id: receiverId,
      });

    if (!receiverUser) {
      return json({
        error: "Receiver not found",
      }, 404);
    }

    const messageData = {
      sender: senderId,
      receiver: receiverId,
      text: text || "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (media) {
      messageData.media = media;
      messageData.mediaType = mediaType || null;
    }

    const result =
      await db.collection("messages").insertOne(
        messageData
      );

    const message =
      await db.collection("messages").findOne({
        _id: result.insertedId,
      });

    if (!message) {
      return json({
        error: "Failed to create message",
      }, 500);
    }

    const sender =
      await db.collection("users").findOne(
        { _id: senderId },
        {
          projection: {
            _id: 1,
            name: 1,
            profilePic: 1,
          },
        }
      );

    const populatedMessage = {
      ...message,
      sender: sender || {
        _id: senderId,
      },
    };

    try {
      await db.collection("notifications").insertOne({
        recipient: receiverId,
        sender: senderId,
        senders: [senderId],
        count: 1,
        type: "MESSAGE",
        text: `${sender?.name || "Someone"} sent you a message`,
        post: null,
        read: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (notificationError) {
      console.log(
        "MESSAGE NOTIFICATION ERROR:",
        notificationError
      );
    }

    return json(populatedMessage);

  } catch (error) {
    console.error(
      "SEND MESSAGE ERROR:",
      error
    );

    return json({ error: error.message }, getErrorStatus(error));
  }
}

/* ================= GET MESSAGES ================= */

export async function getMessages(
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

    const messages =
      await db.collection("messages")
        .find({
          $or: [
            {
              sender: currentUserId,
              receiver: otherUserId,
            },
            {
              sender: otherUserId,
              receiver: currentUserId,
            },
          ],
          deletedFor: {
            $nin: [currentUserId.toString()],
          },
        })
        .sort({
          createdAt: 1,
        })
        .toArray();

    const senderIds = [
      ...new Set(
        messages
          .map(message =>
            message.sender?.toString()
          )
          .filter(Boolean)
      ),
    ]
      .filter(id => ObjectId.isValid(id))
      .map(id => new ObjectId(id));

    let users = [];

    if (senderIds.length) {
      users =
        await db.collection("users")
          .find({
            _id: {
              $in: senderIds,
            },
          })
          .project({
            _id: 1,
            name: 1,
            profilePic: 1,
          })
          .toArray();
    }

    const userMap = new Map(
      users.map(user => [
        user._id.toString(),
        user,
      ])
    );

    const populatedMessages =
      messages.map(message => ({
        ...message,
        sender:
          userMap.get(
            message.sender?.toString()
          ) || message.sender,
      }));

    return json(populatedMessages);

  } catch (error) {
    console.error(
      "GET MESSAGES ERROR:",
      error
    );

    return json({ error: error.message }, getErrorStatus(error));
  }
}

/* ================= EDIT MESSAGE ================= */

export async function editMessage(
  request,
  env,
  db,
  messageId
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    if (!ObjectId.isValid(messageId)) {
      return json({
        error: "Invalid message ID",
      }, 400);
    }

    const id =
      new ObjectId(messageId);

    const message =
      await db.collection("messages").findOne({
        _id: id,
      });

    if (!message) {
      return json({
        error: "Message not found",
      }, 404);
    }

    if (
      message.sender?.toString() !==
      currentUserId.toString()
    ) {
      return json({
        error: "Not allowed",
      }, 403);
    }

    const body = await request.json();

    await db.collection("messages").updateOne(
      {
        _id: id,
      },
      {
        $set: {
          text: body?.text || "",
          edited: true,
          editedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    const updatedMessage =
      await db.collection("messages").findOne({
        _id: id,
      });

    if (!updatedMessage) {
      return json({
        error: "Message not found",
      }, 404);
    }

    const sender =
      await db.collection("users").findOne(
        { _id: currentUserId },
        {
          projection: {
            _id: 1,
            name: 1,
            profilePic: 1,
          },
        }
      );

    return json({
      ...updatedMessage,
      sender: sender || {
        _id: currentUserId,
      },
    });

  } catch (error) {
    console.error(
      "EDIT MESSAGE ERROR:",
      error
    );

    return json({ error: error.message }, getErrorStatus(error));
  }
}

/* ================= DELETE FOR ME ================= */

export async function deleteMessageForMe(
  request,
  env,
  db,
  messageId
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    if (!ObjectId.isValid(messageId)) {
      return json({
        error: "Invalid message ID",
      }, 400);
    }

    const id =
      new ObjectId(messageId);

    const message =
      await db.collection("messages").findOne({
        _id: id,
      });

    if (!message) {
      return json({
        error: "Message not found",
      }, 404);
    }

    const isParticipant =
      message.sender?.toString() ===
        currentUserId.toString() ||
      message.receiver?.toString() ===
        currentUserId.toString();

    if (!isParticipant) {
      return json({
        error: "Not allowed",
      }, 403);
    }

    await db.collection("messages").updateOne(
      {
        _id: id,
      },
      {
        $addToSet: {
          deletedFor: currentUserId.toString(),
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    return json({
      success: true,
    });

  } catch (error) {
    console.error(
      "DELETE MESSAGE FOR ME ERROR:",
      error
    );

    return json({ error: error.message }, getErrorStatus(error));
  }
}

/* ================= DELETE FOR EVERYONE ================= */

export async function deleteMessageForEveryone(
  request,
  env,
  db,
  messageId
) {
  try {
    const currentUserId =
      await authenticate(request, env);

    if (!ObjectId.isValid(messageId)) {
      return json({
        error: "Invalid message ID",
      }, 400);
    }

    const id =
      new ObjectId(messageId);

    const message =
      await db.collection("messages").findOne({
        _id: id,
      });

    if (!message) {
      return json({
        error: "Message not found",
      }, 404);
    }

    if (
      message.sender?.toString() !==
      currentUserId.toString()
    ) {
      return json({
        error: "Not allowed",
      }, 403);
    }

    const age =
      Date.now() -
      new Date(message.createdAt).getTime();

    const oneHour =
      60 * 60 * 1000;

    if (age > oneHour) {
      return json({
        error:
          "You can only delete messages within 1 hour",
      }, 400);
    }

    await db.collection("messages").deleteOne({
      _id: id,
    });

    return json({
      success: true,
    });

  } catch (error) {
    console.error(
      "DELETE MESSAGE FOR EVERYONE ERROR:",
      error
    );

    return json({ error: error.message }, getErrorStatus(error));
  }
}
