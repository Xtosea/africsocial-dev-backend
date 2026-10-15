// server.js
import "./config/env.js";
import express from "express";
import path from "path";
import mongoose from "mongoose";
import cors from "cors";
import rateLimit from "express-rate-limit";
import http from "http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import {
  joinPKRoom,
  leavePKRoom,
  startPKRoom,
  getPKRoomState,
  updatePKRoomScore,
  addPKRoomScore,
  deletePKRoom,
  
} from "./services/pkSocketService.js";

import {
  finishPK,
} from "./services/pkService.js";

import {
  settlePKReward,
} from "./services/pkRewardService.js";
import {
  sendPKGift,
} from "./services/pkGiftService.js";

import "./config/env.js";
import "./config/redis.js";

import fileUpload from "express-fileupload";
import helmet from "helmet";

/* ================= MODELS ================= */
import Message from "./models/Message.js";
import Post from "./models/Post.js";
import PKBattle from "./models/PKBattle.js";


/* ================= ROUTES ================= */
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import leaderboardRoutes from "./routes/leaderboardRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import storyRoutes from "./routes/storyRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import imagekitRoutes from "./routes/imagekitRoutes.js";
import cloudinaryRoutes from "./routes/cloudinaryRoutes.js";
import videoRoutes from "./routes/videoRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import r2StoryRoutes from "./routes/r2StoryRoutes.js";

import r2Routes from "./routes/r2Routes.js";
import storyFeedRoutes from "./routes/storyFeedRoutes.js";
import walletRoutes from "./routes/walletRoutes.js";
import friendRoutes from "./routes/friendRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import socialCardRoutes
from "./routes/socialCardRoutes.js";
import storyMusicRoutes
from "./routes/storyMusicRoutes.js";

import storyMusicAdminRoutes
from "./routes/storyMusicAdminRoutes.js";

import storyR2Routes from "./routes/storyR2Routes.js";
import adRoutes
from "./routes/adRoutes.js";
import creatorRoutes
from "./routes/creatorRoutes.js";
import adminRoutes
from "./routes/adminRoutes.js";
import earningRoutes
from "./routes/earningRoutes.js";
import adminStatsRoutes from "./routes/adminStatsRoutes.js";
import r2StoryMusicRoutes from "./routes/r2StoryMusicRoutes.js";
import storyCloudinaryRoutes from "./routes/storyCloudinaryRoutes.js";
import marketplaceRoutes from "./routes/marketplaceRoutes.js";
import socialPreviewRoutes from "./routes/socialPreviewRoutes.js";
import musicRoutes from "./routes/musicRoutes.js";
import stickerRoutes from "./routes/stickerRoutes.js";
import transactionRoutes from "./routes/transactionRoutes.js";
import pkRoutes from "./routes/pkRoutes.js";
import giftRoutes from "./routes/giftRoutes.js";












const app = express();
app.set("trust proxy", 1);

/* ================= CORS ================= */
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_BACKUP_URL,
  "https://dev.africsocial.com",
   "https://africbook.globelynks.com",
  ];

app.use(
  cors({
    origin: (origin, callback) => {
      console.log("Incoming Origin:", origin);
      console.log("Allowed Origins:", allowedOrigins);

      // Allow requests with no Origin (e.g. server-to-server, Postman)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("Blocked Origin:", origin);

      return callback(
        new Error("CORS policy does not allow access from this origin"),
        false
      );
    },

    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

/* ================= HELMET + CSP ================= */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", "data:", "blob:", "https:"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://dev.africsocial.com",
          "https://static.cloudflareinsights.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: [
          "'self'",
          "ws:",
          "wss:",
          "https://africsocial.globelynks.com",
          process.env.FRONTEND_URL,
          process.env.FRONTEND_BACKUP_URL,
          process.env.BACKEND_URL || "https://afribook-backend.onrender.com",
        ],
        fontSrc: ["'self'", "https:", "data:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        frameSrc: ["'self'", "https:"],
      },
    },
  })
);

// Allow images to be used cross-origin
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

/* ================= BODY PARSER ================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

//DEBUGGING ONLY 
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});


/* ================= FILEUPLOAD ================= */
app.use(
  fileUpload({
    useTempFiles: false,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  })
);


/* ================= RATE LIMIT ================= */
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
});
app.use("/api/auth/resend-verification", emailLimiter);
app.use("/api/auth/forgot-password", emailLimiter);


/* ================= STATIC FILES ================= */
// Profile images
app.use("/uploads/profiles", express.static(path.join(process.cwd(), "public/uploads/profiles")));
// Media uploads
app.use("/uploads/media", express.static(path.join(process.cwd(), "public/uploads/media")));
// Default profile/cover images
app.use("/profile", express.static(path.join(process.cwd(), "public/profile")));



/* ================= API ROUTES ================= */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/stories", storyRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/imagekit", imagekitRoutes);
app.use("/api/cloudinary", cloudinaryRoutes);
app.use("/api/videos", videoRoutes);

app.use("/api/r2", r2Routes);
app.use("/api/r2stories", r2StoryRoutes);
app.use("/api/stories", storyFeedRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/post-card",socialCardRoutes);
app.use(
  "/api/story-music",
  storyMusicRoutes
);

app.use(
  "/api/story-music-admin",
  storyMusicAdminRoutes
);
        
app.use("/api/storyR2", storyR2Routes);

app.use("/api/ad", adRoutes);

app.use("/api/creator", creatorRoutes);

app.use("/api/admin", adminRoutes);

app.use(
  "/api/earnings",
  earningRoutes
);

app.use(
  "/api/admin",
  adminStatsRoutes
);
app.use("/api/storyCloudinary", storyCloudinaryRoutes);
app.use("/api/r2StoryMusic", r2StoryMusicRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/", socialPreviewRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/music", musicRoutes);
app.use("/api/stickers", stickerRoutes);
app.use("/api/pk", pkRoutes);
app.use("/api/gifts", giftRoutes);



  

                   

/* ================= TEST ROUTE ================= */
app.get("/", (req, res) => {
  res.send("AfricSocial API running 🚀");
});

/* ================= CREATE HTTP SERVER ================= */
const server = http.createServer(app);

/* ================= SOCKET.IO ================= */
export const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  path: "/socket.io",
});

import { setIO } from "./utils/socket.js";

setIO(io);

/* ================= SOCKET AUTH ================= */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;

  if (!token) {
    console.log("❌ No token provided");
    return next(new Error("No token provided"));
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    socket.userId = decoded.id;

    next();

  } catch (error) {
    console.error(
      "❌ Socket authentication failed:",
      error.message
    );

    next(new Error("Invalid token"));
  }
});


// ==========================================
// PK BATTLE FINALIZER
// ==========================================

const pkTimers = new Map();

const schedulePKEnd = (battle) => {

  const battleId =
    battle._id.toString();

  // Prevent duplicate timers
  if (pkTimers.has(battleId)) {
    return;
  }

  if (
    battle.status !== "active" ||
    !battle.startedAt ||
    !battle.duration
  ) {
    return;
  }

  const startedAt =
    new Date(battle.startedAt)
      .getTime();

  const durationMs =
    Number(battle.duration) * 1000;

  const endAt =
    startedAt + durationMs;

  const remaining =
    Math.max(
      0,
      endAt - Date.now()
    );

  console.log(
    `⏱️ PK ${battleId} scheduled to end in ${remaining}ms`
  );

  const timer =
    setTimeout(
      async () => {

        try {

          await finalizePKBattle(
            battleId
          );

        } catch (error) {

          console.error(
            "❌ PK automatic finalization error:",
            error
          );

        }

      },
      remaining
    );

  pkTimers.set(
    battleId,
    timer
  );
};


// ==========================================
// FINALIZE PK BATTLE
// ==========================================

const finalizePKBattle = async (
  battleId
) => {

  try {

    const battle =
      await PKBattle.findById(
        battleId
      );

    if (!battle) {

      console.log(
        `⚠️ PK battle ${battleId} not found`
      );

      pkTimers.delete(
        battleId
      );

      return;
    }

    // Already finished
    if (
      battle.status === "completed" ||
      battle.status === "cancelled"
    ) {

      pkTimers.delete(
        battleId
      );

      return;
    }

    // --------------------------------------
    // Get final Redis score
    // --------------------------------------

    const roomState =
      await getPKRoomState(
        battleId
      );

    const finalHostAScore =
      roomState?.hostAScore ??
      battle.hostAScore ??
      0;

    const finalHostBScore =
      roomState?.hostBScore ??
      battle.hostBScore ??
      0;

    // --------------------------------------
    // Save final scores
    // --------------------------------------

    battle.hostAScore =
      finalHostAScore;

    battle.hostBScore =
      finalHostBScore;

    // --------------------------------------
    // Determine winner
    // --------------------------------------

    let winner = null;

    if (
      finalHostAScore >
      finalHostBScore
    ) {

      winner =
        battle.hostA
          ?.toString();

    } else if (
      finalHostBScore >
      finalHostAScore
    ) {

      winner =
        battle.hostB
          ?.toString();

    }

    // --------------------------------------
    // Save result
    // --------------------------------------

    battle.status =
      "completed";

    battle.endedAt =
    new Date();

    // If your PKBattle schema has a winner
    // field, save it.
    if (
      Object.prototype.hasOwnProperty.call(
        battle.toObject(),
        "winner"
      )
    ) {

      battle.winner =
        winner;
    }

    await battle.save();


    // --------------------------------------
// Settle PK reward
// --------------------------------------

const reward =
  await settlePKReward(
    battle._id
  );

console.log(
  `💰 PK reward settled: ${battleId}`,
  {
    result: reward.result,
    totalCoinsSpent: reward.totalCoinsSpent,
    platformFee: reward.platformFee,
    creatorRewardPool: reward.creatorRewardPool,
    winnerReward: reward.winnerReward,
    status: reward.status,
    reference: reward.reference,
  }
);


    // --------------------------------------
    // Final state
    // --------------------------------------

    const finalState = {

      battleId,

      hostA:
        battle.hostA,

      hostB:
        battle.hostB,

      hostAScore:
        finalHostAScore,

      hostBScore:
        finalHostBScore,

      winner,

      draw:
        winner === null,

      startedAt:
        battle.startedAt,

      endedAt:
      battle.endedAt,

      duration:
        battle.duration,

      status:
        "completed",

    };

    const roomName =
      `pk:${battleId}`;

    // --------------------------------------
    // Broadcast final result
    // --------------------------------------

    io.to(
      roomName
    ).emit(
      "pk:finished",
      {
        ...finalState,

        battleId,

        status:
          "completed",

        endedAt:
          battle.endedAt,

        hostAScore:
          battle.hostAScore,

        hostBScore:
          battle.hostBScore,

        winner:
          battle.winner,

        reward,
      }
    );


    // --------------------------------------
    // PK ended event
    // --------------------------------------

    io.to(
      roomName
    ).emit(
      "pk:ended",
      {
        ...finalState,

        battleId,

        status:
          "completed",

        endedAt:
          battle.endedAt,

        hostAScore:
          battle.hostAScore,

        hostBScore:
          battle.hostBScore,

        winner:
          battle.winner,

        reward,
      }
    );


    // --------------------------------------
    // Final room state
    // --------------------------------------

    io.to(
      roomName
    ).emit(
      "pk:room-state",
      {
        ...(finalState || {}),

        battleId,

        started:
          false,

        hostAScore:
          battle.hostAScore,

        hostBScore:
          battle.hostBScore,

        reward,
      }
    );

    console.log(
      `🏁 PK completed: ${battleId}`,
      finalState
    );

    // --------------------------------------
    // Remove Redis room
    // --------------------------------------

    await deletePKRoom(
      battleId
    );

    // --------------------------------------
    // Remove timer
    // --------------------------------------

    pkTimers.delete(
      battleId
    );

  } catch (error) {

    console.error(
      `❌ Failed to finalize PK ${battleId}:`,
      error
    );

    pkTimers.delete(
      battleId
    );

    throw error;
  }
};

/* ================= SOCKET EVENTS ================= */
const onlineUsers = new Map();

const activeCalls = new Set();

const callSessions = new Map();

io.on("connection", (socket) => {

  console.log(
    "🟢 Socket connected:",
    socket.id
  );

  // JOIN USER ROOM
  socket.on("join", () => {

  // socket.userId comes from the verified JWT.
  // Never trust a user ID supplied by the frontend.

  if (!socket.userId) {
    console.log("❌ Cannot join user room: unauthenticated socket");
    return;
  }

  const userId = socket.userId.toString();

  socket.join(userId);

  onlineUsers.set(userId, socket.id);

  io.emit(
    "online-users",
    Array.from(onlineUsers.keys())
  );

  console.log(`👤 ${userId} is online`);
});

  // SEND MESSAGE
  socket.on(
    "send-message",
    async (data) => {

      try {

        const message =
          await Message.create(data);

        io.to(
          data.receiver
        ).emit(
          "receive-message",
          message
        );

        io.to(
          data.sender
        ).emit(
          "receive-message",
          message
        );

      } catch (error) {

        console.error(
          "Message error:",
          error
        );
      }
    }
  );

// MESSAGE EDITED
socket.on(
  "message-edited",
  (updatedMessage) => {

    io.emit(
      "message-edited",
      updatedMessage
    );

  }
);

// MESSAGE DELETED
socket.on(
  "message-deleted",
  ({ messageId }) => {

    io.emit(
      "message-deleted",
      { messageId }
    );

  }
);

  // ================= CALL EVENTS =================

// CALL USER 
  socket.on("call-user", (data) => {

  console.log("📞 call-user received");

  const receiverSocket = onlineUsers.get(data.to);

  if (!receiverSocket) {
    io.to(data.from).emit("user-offline");
    return;
  }

  if (activeCalls.has(data.to)) {
    io.to(data.from).emit("call-busy");
    return;
  }

  activeCalls.add(data.from);
  activeCalls.add(data.to);

callSessions.set(data.from, data.to);
callSessions.set(data.to, data.from);

  io.to(receiverSocket).emit("incoming-call", {
  from: data.from,
  signal: data.signal,
  callType: data.callType,
  name: data.name,
  profilePic: data.profilePic,
});

}); // <-- THIS IS MISSING

 // ANSWER CALL
  socket.on("answer-call", (data) => {

  console.log("✅ ANSWER CALL");
  console.log(data);

  io.to(data.to).emit("call-accepted", data.signal);

  console.log("✅ call-accepted emitted");
});


socket.on("reject-call", (data) => {

  activeCalls.delete(socket.userId);
  activeCalls.delete(data.to);

  callSessions.delete(socket.userId);
  callSessions.delete(data.to);

  io.to(data.to).emit("call-rejected");

});

// ICE CANDIDATE 
socket.on("ice-candidate", (data) => {

  console.log("🧊 ICE");
  console.log(data);

  io.to(data.to).emit("ice-candidate", {
    candidate: data.candidate,
    from: data.from,
  });
});




// END CALL
  socket.on("end-call", (data) => {

  activeCalls.delete(socket.userId);
  activeCalls.delete(data.to);

  callSessions.delete(socket.userId);
  callSessions.delete(data.to);

  io.to(data.to).emit("call-ended");

});


// ==========================================
// PK SOCKET EVENTS
// ==========================================
//
// Socket.IO handles real-time communication.
// Redis handles live room state.
// MongoDB handles persistent battle state.
//
// ==========================================


// ------------------------------------------
// Track PK rooms joined by this socket
// ------------------------------------------

const socketPKRooms =
  new Map();


// ==========================================
// JOIN PK
// ==========================================

socket.on(
  "pk:join",
  async (data) => {

    try {

      const {
        battleId,
      } = data || {};


      if (!battleId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Battle ID is required",
          }
        );
      }


      if (!socket.userId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "User not authenticated",
          }
        );
      }


      // ----------------------------------------
      // Find MongoDB battle
      // ----------------------------------------

      const battle =
        await PKBattle.findById(
          battleId
        );


      if (!battle) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK battle not found",
          }
        );
      }


      // ----------------------------------------
      // Only hosts can join as participants
      // ----------------------------------------

      const userId =
        socket.userId.toString();


      const isHostA =
        battle.hostA
          .toString() === userId;


      const isHostB =
        battle.hostB
          .toString() === userId;


      if (
        !isHostA &&
        !isHostB
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "You are not a host of this PK",
          }
        );
      }


      // ----------------------------------------
      // Do not allow ended battles
      // ----------------------------------------

      if (
        battle.status ===
          "completed" ||
        battle.status ===
          "cancelled"
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "This PK has already ended",
          }
        );
      }


      const roomName =
        `pk:${battleId}`;


      // ----------------------------------------
      // Join Socket.IO room
      // ----------------------------------------

      socket.join(
        roomName
      );


      // ----------------------------------------
      // Track socket PK membership
      // ----------------------------------------

      if (
        !socketPKRooms.has(
          socket.id
        )
      ) {

        socketPKRooms.set(
          socket.id,
          new Set()
        );
      }


      socketPKRooms
        .get(socket.id)
        .add(battleId);


      // ----------------------------------------
      // Join Redis room
      // ----------------------------------------

      await joinPKRoom(
        battleId,
        socket.userId
      );


      // ----------------------------------------
      // MongoDB → Redis synchronization
      //
      // MongoDB has the persistent score.
      // Redis becomes the live score.
      // ----------------------------------------

      if (
        battle.status ===
        "active"
      ) {

        await startPKRoom(
          battleId,
          battle.startedAt
        );

      }


      await updatePKRoomScore(
        battleId,

        battle.hostAScore ||
          0,

        battle.hostBScore ||
          0
      );


      // ----------------------------------------
      // Get final synchronized state
      // ----------------------------------------

      const state =
        await getPKRoomState(
          battleId
        );


      // ----------------------------------------
      // Send state to everyone
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:room-state",
        state
      );


      // ----------------------------------------
      // Tell this socket its role
      // ----------------------------------------

      socket.emit(
        "pk:joined",
        {
          battleId,

          role:
            isHostA
              ? "hostA"
              : "hostB",

          state,
        }
      );


      console.log(
        `🥊 ${userId} joined PK ${battleId} as ${
          isHostA
            ? "Host A"
            : "Host B"
        }`
      );


    } catch (error) {

      console.error(
        "PK join error:",
        error
      );


      socket.emit(
        "pk:error",
        {
          message:
            error.message ||
            "Failed to join PK",
        }
      );

    }

  }
);


// ==========================================
// GET PK STATE
// ==========================================

socket.on(
  "pk:get-state",
  async (data) => {

    try {

      const {
        battleId,
      } = data || {};


      if (!battleId) {
        return;
      }


      const battle =
        await PKBattle.findById(
          battleId
        );


      if (!battle) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK battle not found",
          }
        );
      }


      // ----------------------------------------
      // If Redis room disappeared, rebuild it
      // from MongoDB.
      // ----------------------------------------

      let state =
        await getPKRoomState(
          battleId
        );


      if (!state) {

        if (
          battle.status ===
          "completed" ||
          battle.status ===
          "cancelled"
        ) {

          return socket.emit(
            "pk:error",
            {
              message:
                "PK room not found",
            }
          );
        }


        await updatePKRoomScore(
          battleId,

          battle.hostAScore ||
            0,

          battle.hostBScore ||
            0
        );


        if (
          battle.status ===
          "active"
        ) {

          await startPKRoom(
            battleId,
            battle.startedAt
          );

        }


        state =
          await getPKRoomState(
            battleId
          );

      }


      socket.emit(
        "pk:room-state",
        state
      );


    } catch (error) {

      console.error(
        "PK state error:",
        error
      );


      socket.emit(
        "pk:error",
        {
          message:
            error.message ||
            "Failed to get PK state",
        }
      );

    }

  }
);


// ==========================================
// START PK
// ==========================================

socket.on(
  "pk:start",
  async (data) => {

    try {

      const {
        battleId,
      } = data || {};


      if (!battleId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Battle ID is required",
          }
        );
      }


      if (!socket.userId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "User not authenticated",
          }
        );
      }


      const battle =
        await PKBattle.findById(
          battleId
        );


      if (!battle) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK battle not found",
          }
        );
      }


      // ----------------------------------------
      // Verify host
      // ----------------------------------------

      const userId =
        socket.userId.toString();


      const isHostA =
        battle.hostA
          .toString() === userId;


      const isHostB =
        battle.hostB
          .toString() === userId;


      if (
        !isHostA &&
        !isHostB
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "You are not a host of this PK",
          }
        );
      }


      // ----------------------------------------
      // Validate status
      // ----------------------------------------

      if (
        battle.status !==
        "pending"
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              battle.status ===
              "active"
                ? "PK is already active"
                : "PK can no longer be started",
          }
        );
      }


      // ----------------------------------------
      // Start MongoDB battle
      // ----------------------------------------

      battle.status =
        "active";

      battle.startedAt =
        new Date();

      await battle.save();


      // ----------------------------------------
      // Start Redis room
      // ----------------------------------------

      await startPKRoom(
        battleId,
        battle.startedAt
      );


      // ----------------------------------------
      // Synchronize scores
      // ----------------------------------------

      await updatePKRoomScore(
        battleId,

        battle.hostAScore ||
          0,

        battle.hostBScore ||
          0
      );


      const state =
        await getPKRoomState(
          battleId
        );


      const roomName =
        `pk:${battleId}`;


      // ----------------------------------------
      // Broadcast START
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:started",
        {
          battleId,

          started:
            true,

          startedAt:
            battle.startedAt,

          duration:
            battle.duration,

          hostA:
            battle.hostA,

          hostB:
            battle.hostB,

          hostAScore:
            state?.hostAScore ||
            0,

          hostBScore:
            state?.hostBScore ||
            0,
        }
      );


      // ----------------------------------------
      // Broadcast state
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:room-state",
        state
      );


      console.log(
        `🚀 PK started: ${battleId}`
      );

    } catch (error) {

      console.error(
        "PK start error:",
        error
      );


      socket.emit(
        "pk:error",
        {
          message:
            error.message ||
            "Failed to start PK",
        }
      );

    }

  }
);




// ==========================================
// ADD PK SCORE
// ==========================================

socket.on(
  "pk:score",
  async (data) => {

    try {

      const {
        battleId,
        points,
      } = data || {};


      if (!battleId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Battle ID is required",
          }
        );
      }


      if (!socket.userId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "User not authenticated",
          }
        );
      }


      const numericPoints =
        Number(points);


      if (
        !Number.isFinite(
          numericPoints
        ) ||
        numericPoints <= 0 ||
        !Number.isSafeInteger(
          numericPoints
        )
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Invalid score points",
          }
        );
      }
      // ----------------------------------------
      // TEMPORARY TEST LIMIT
      //
      // Remove this later when gifts/reactions
      // become the trusted scoring source.
      // ----------------------------------------

      if (
        numericPoints >
        1000
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Maximum test score is 1000",
          }
        );
      }


      const battle =
        await PKBattle.findById(
          battleId
        );


      if (!battle) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK battle not found",
          }
        );
      }


      if (
        battle.status !==
        "active"
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK is not active",
          }
        );
      }


      // ----------------------------------------
      // Verify host
      // ----------------------------------------

      const userId =
        socket.userId.toString();


      const isHostA =
        battle.hostA
          .toString() === userId;


      const isHostB =
        battle.hostB
          .toString() === userId;


      if (
        !isHostA &&
        !isHostB
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "You are not a host of this PK",
          }
        );
      }


      // ----------------------------------------
      // Atomic Redis increment
      // ----------------------------------------

      const scoreState =
        await addPKRoomScore(
          battleId,
          isHostA,
          numericPoints
        );


      // ----------------------------------------
      // Persist score using MongoDB ATOMIC $inc
      //
      // This prevents simultaneous Host A/B
      // score updates from overwriting each other.
      // ----------------------------------------

      const increment =
        isHostA
          ? {
              hostAScore:
                numericPoints,
            }
          : {
              hostBScore:
                numericPoints,
            };


      await PKBattle.updateOne(
        {
          _id:
            battleId,

          status:
            "active",
        },

        {
          $inc:
            increment,
        }
      );


      const roomName =
        `pk:${battleId}`;


      // ----------------------------------------
      // Broadcast score
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:score-updated",
        {
          battleId,

          hostAScore:
            scoreState.hostAScore,

          hostBScore:
            scoreState.hostBScore,

          addedBy:
            socket.userId,

          points:
            numericPoints,

          side:
            isHostA
              ? "hostA"
              : "hostB",
        }
      );


      // ----------------------------------------
      // Broadcast complete state
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:room-state",
        scoreState
      );


      console.log(
        `🥊 PK score +${numericPoints}`,
        {
          battleId,

          userId:
            socket.userId,

          side:
            isHostA
              ? "Host A"
              : "Host B",

          hostAScore:
            scoreState.hostAScore,

          hostBScore:
            scoreState.hostBScore,
        }
      );


    } catch (error) {

      console.error(
        "PK score socket error:",
        error
      );


      socket.emit(
        "pk:error",
        {
          message:
            error.message ||
            "Failed to update PK score",
        }
      );

    }

  }
);


// ==========================================
// SEND PK GIFT
// ==========================================
//
// Client:
// socket.emit("pk:gift", {
//   battleId,
//   receiverId,
//   giftId,
// });
//
// Server:
// 1. Validates the PK
// 2. Deducts User.coins
// 3. Records CoinTransaction
// 4. Adds PK points
// 5. Synchronizes Redis
// 6. Broadcasts the gift to the PK room
// ==========================================

socket.on(
  "pk:gift",
  async (data) => {

    try {

      const {
        battleId,
        receiverId,
        giftId,
      } = data || {};


      // ----------------------------------------
      // AUTHENTICATION
      // ----------------------------------------

      if (!socket.userId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "User not authenticated",
          }
        );
      }


      // ----------------------------------------
      // VALIDATION
      // ----------------------------------------

      if (
        !battleId ||
        !receiverId ||
        !giftId
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Battle ID, receiver ID and gift ID are required",
          }
        );
      }


      // ----------------------------------------
      // SEND GIFT
      //
      // This handles:
      // - User.coins deduction
      // - insufficient coins
      // - gift validation
      // - PK validation
      // - PK score update
      // - CoinTransaction
      // ----------------------------------------

      const result =
        await sendPKGift({
          senderId:
            socket.userId,

          battleId,

          receiverId,

          giftId,
        });


      // ----------------------------------------
      // SYNCHRONIZE REDIS SCORE
      // ----------------------------------------

      const mongoBattle =
        result.battle;


      if (!mongoBattle) {

        throw new Error(
          "Gift was processed but PK battle data was not returned"
        );
      }


      const scoreState =
        await updatePKRoomScore(
          battleId,

          mongoBattle.hostAScore,

          mongoBattle.hostBScore
        );


      const roomName =
        `pk:${battleId}`;


      // ----------------------------------------
      // BROADCAST GIFT
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:gift-received",
        {

          battleId,

          senderId:
            socket.userId.toString(),

          receiverId:
            receiverId.toString(),

          gift:
            result.gift,

          receiverSide:
            result.receiverSide,

          balanceAfter:
            result.balanceAfter,

          hostAScore:
            scoreState.hostAScore,

          hostBScore:
            scoreState.hostBScore,

        }
      );


      // ----------------------------------------
      // SEND SUCCESS TO SENDER
      // ----------------------------------------

      socket.emit(
        "pk:gift-sent",
        {

          success:
            true,

          battleId,

          receiverId,

          gift:
            result.gift,

          balanceBefore:
            result.balanceBefore,

          balanceAfter:
            result.balanceAfter,

          hostAScore:
            scoreState.hostAScore,

          hostBScore:
            scoreState.hostBScore,

        }
      );


      // ----------------------------------------
      // BROADCAST COMPLETE ROOM STATE
      // ----------------------------------------

      io.to(
        roomName
      ).emit(
        "pk:room-state",
        scoreState
      );


      console.log(
        "🎁 PK gift sent:",
        {
          battleId,

          senderId:
            socket.userId,

          receiverId,

          giftId,

          gift:
            result.gift?.name,

          coinCost:
            result.gift?.coinCost,

          pkPoints:
            result.gift?.pkPoints,

          balanceAfter:
            result.balanceAfter,

          hostAScore:
            scoreState.hostAScore,

          hostBScore:
            scoreState.hostBScore,
        }
      );


    } catch (error) {

      console.error(
        "❌ PK gift socket error:",
        error
      );


      socket.emit(
        "pk:error",
        {
          message:
            error.message ||
            "Failed to send PK gift",
        }
      );

    }

  }
);


// ==========================================
// FINISH PK
// ==========================================

socket.on(
  "pk:finish",
  async (data) => {

    try {

      const {
        battleId,
      } = data || {};


      if (!battleId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "Battle ID is required",
          }
        );
      }


      if (!socket.userId) {

        return socket.emit(
          "pk:error",
          {
            message:
              "User not authenticated",
          }
        );
      }


      const battle =
        await PKBattle.findById(
          battleId
        );


      if (!battle) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK battle not found",
          }
        );
      }


      // ----------------------------------------
      // Verify host
      // ----------------------------------------

      const userId =
        socket.userId.toString();


      const isHostA =
        battle.hostA
          .toString() === userId;


      const isHostB =
        battle.hostB
          .toString() === userId;


      if (
        !isHostA &&
        !isHostB
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "You are not a host of this PK",
          }
        );
      }


      if (
        battle.status !==
        "active"
      ) {

        return socket.emit(
          "pk:error",
          {
            message:
              "PK is not active",
          }
        );
      }


      // ----------------------------------------
// Redis is authoritative for final
// live score.
// ----------------------------------------

const liveState =
  await getPKRoomState(
    battleId
  );


if (liveState) {

  battle.hostAScore =
    liveState.hostAScore;

  battle.hostBScore =
    liveState.hostBScore;

}

      // ----------------------------------------
      // Determine winner
      // ----------------------------------------

      if (
        battle.hostAScore >
        battle.hostBScore
      ) {

        battle.winner =
          battle.hostA;

      } else if (
        battle.hostBScore >
        battle.hostAScore
      ) {

        battle.winner =
          battle.hostB;

      } else {

        battle.winner =
          null;
      }


      battle.status =
        "completed";

      battle.endedAt =
        new Date();


      await battle.save();


      // ----------------------------------------
// Final state
// ----------------------------------------

const finalState = {

  battleId,

  hostA:
    battle.hostA,

  hostB:
    battle.hostB,

  hostAScore:
    battle.hostAScore,

  hostBScore:
    battle.hostBScore,

  winner:
    battle.winner
      ? battle.winner.toString()
      : null,

  draw:
    battle.winner === null,

  startedAt:
    battle.startedAt,

  endedAt:
    battle.endedAt,

  duration:
    battle.duration,

  status:
    "completed",

};


// ----------------------------------------
// Settle PK reward
// ----------------------------------------

const reward =
  await settlePKReward(
    battle._id
  );

console.log(
  `💰 PK reward settled: ${battleId}`,
  {
    result: reward.result,
    totalCoinsSpent: reward.totalCoinsSpent,
    platformFee: reward.platformFee,
    creatorRewardPool: reward.creatorRewardPool,
    winnerReward: reward.winnerReward,
    status: reward.status,
    reference: reward.reference,
  }
);


// ----------------------------------------
// Room
// ----------------------------------------

const roomName =
  `pk:${battleId}`;


// ----------------------------------------
// Broadcast final result
// ----------------------------------------

// Main PK completion event
io.to(
  roomName
).emit(
  "pk:finished",
  {
    ...finalState,

    battleId,

    status:
      "completed",

    endedAt:
      battle.endedAt,

    hostAScore:
      battle.hostAScore,

    hostBScore:
      battle.hostBScore,

    winner:
      battle.winner,

    reward,
  }
);


// ----------------------------------------
// PK ended event
// ----------------------------------------

io.to(
  roomName
).emit(
  "pk:ended",
  {
    ...finalState,

    battleId,

    status:
      "completed",

    endedAt:
      battle.endedAt,

    hostAScore:
      battle.hostAScore,

    hostBScore:
      battle.hostBScore,

    winner:
      battle.winner,

    reward,
  }
);


// ----------------------------------------
// Final room state
// ----------------------------------------

io.to(
  roomName
).emit(
  "pk:room-state",
  {
    ...(finalState || {}),

    battleId,

    started:
      false,

    hostAScore:
      battle.hostAScore,

    hostBScore:
      battle.hostBScore,

    reward,
  }
);

      // ----------------------------------------
      // Redis no longer needed
      // ----------------------------------------

      await deletePKRoom(
        battleId
      );


      console.log(
        `🏆 PK finished: ${battleId}`,
        {
          hostAScore:
            battle.hostAScore,

          hostBScore:
            battle.hostBScore,

          winner:
            battle.winner,
        }
      );


    } catch (error) {

      console.error(
        "PK finish socket error:",
        error
      );


      socket.emit(
        "pk:error",
        {
          message:
            error.message ||
            "Failed to finish PK",
        }
      );

    }

  }
);


// ==========================================
// LEAVE PK
// ==========================================

socket.on(
  "pk:leave",
  async (data) => {

    try {

      const {
        battleId,
      } = data || {};


      if (!battleId) {
        return;
      }


      const roomName =
        `pk:${battleId}`;


      socket.leave(
        roomName
      );


      await leavePKRoom(
        battleId,
        socket.userId
      );


      const rooms =
        socketPKRooms.get(
          socket.id
        );


      if (rooms) {

        rooms.delete(
          battleId
        );

      }


      const state =
        await getPKRoomState(
          battleId
        );


      if (state) {

        io.to(
          roomName
        ).emit(
          "pk:room-state",
          state
        );

      }


      console.log(
        `🚪 ${socket.userId} left PK ${battleId}`
      );


    } catch (error) {

      console.error(
        "PK leave error:",
        error
      );

    }

  }
);

  // DISCONNECT
  // ==========================================
// DISCONNECT
// ==========================================

socket.on(
  "disconnect",
  async () => {

    console.log(
      "🔴 Socket disconnected:",
      socket.id
    );


    // ========================================
    // PK CLEANUP
    // ========================================

    try {

      const rooms =
        socketPKRooms.get(
          socket.id
        );


      if (rooms) {

        for (
          const battleId
          of rooms
        ) {

          try {

            await leavePKRoom(
              battleId,
              socket.userId
            );


            const roomName =
              `pk:${battleId}`;


            const state =
              await getPKRoomState(
                battleId
              );


            if (state) {

              io.to(
                roomName
              ).emit(
                "pk:room-state",
                state
              );

            }


            console.log(
              `🚪 ${socket.userId} disconnected from PK ${battleId}`
            );


          } catch (error) {

            console.error(
              `PK disconnect cleanup failed for ${battleId}:`,
              error
            );

          }

        }


        socketPKRooms.delete(
          socket.id
        );

      }

    } catch (error) {

      console.error(
        "PK disconnect cleanup error:",
        error
      );

    }


    // ========================================
    // ONLINE USER CLEANUP
    // ========================================

    if (socket.userId) {

      onlineUsers.delete(
        socket.userId
      );


      io.emit(
        "online-users",
        Array.from(
          onlineUsers.keys()
        )
      );


      // ======================================
      // CALL CLEANUP
      // ======================================

      activeCalls.delete(
        socket.userId
      );


      const partner =
        callSessions.get(
          socket.userId
        );


      if (partner) {

        io.to(
          partner
        ).emit(
          "call-ended"
        );


        activeCalls.delete(
          partner
        );


        callSessions.delete(
          partner
        );

      }


      callSessions.delete(
        socket.userId
      );


      console.log(
        `👤 ${socket.userId} went offline`
      );

    }

  }
);

// IMPORTANT: closes io.on("connection", (socket) => {
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB Connected");

    // ==========================================
    // RESTORE ACTIVE PK TIMERS
    // ==========================================

    const activeBattles =
      await PKBattle.find({
        status: "active",
        startedAt: {
          $ne: null,
        },
      });

    console.log(
      `🥊 Restoring ${activeBattles.length} active PK battle(s)`
    );

    for (const battle of activeBattles) {
      schedulePKEnd(battle);
    }

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `🚀 Server running on port ${PORT}`
      );
    });

  } catch (err) {

    console.error(
      "❌ Startup error:",
      err
    );

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `⚠️ Server running WITHOUT DB on port ${PORT}`
      );
    });

  }
};

startServer();