import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

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

export async function register(request, env, db) {
  try {
    const {
      name,
      identifier,
      password,
      ref,
    } = await request.json();

    if (!name || !identifier || !password) {
      return json({
        message: "Name, email or phone, and password are required",
      }, 400);
    }

    const cleanIdentifier = identifier.trim();
    const cleanName = name.trim();

    const isEmail = cleanIdentifier.includes("@");

    const email = isEmail
      ? cleanIdentifier.toLowerCase()
      : null;

    const phone = !isEmail
      ? cleanIdentifier
      : null;

    // ================= CHECK EXISTING USER =================

    const existingUser = await db.collection("users").findOne(
      isEmail
        ? { email }
        : { phone }
    );

    if (existingUser) {
      return json({
        message: isEmail
          ? "Email already exists"
          : "Phone number already exists",
      }, 400);
    }

    // ================= HASH PASSWORD =================

    const hashedPassword = await bcrypt.hash(password, 10);

    // ================= REFERRAL CODE =================

    const referralCode =
      "AFR" +
      Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();

    // ================= REFERRER =================

    let referredBy = null;

    if (ref) {
      const referrer = await db.collection("users").findOne({
        referralCode: ref.trim(),
      });

      if (referrer) {
        referredBy = referrer._id;
      }
    }

    // ================= CREATE USER =================

    const userData = {
      name: cleanName,
      password: hashedPassword,
      role: "user",
      referralCode,
      referredBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // IMPORTANT:
    // Only save the identifier supplied.
    // Do NOT save email: "" or phone: "".

    if (isEmail) {
      userData.email = email;
    } else {
      userData.phone = phone;
    }

    const result = await db.collection("users").insertOne(userData);

    const userId = result.insertedId;

    // ================= CREATE WALLET =================

    await db.collection("wallets").insertOne({
      user: userId,
      points: 0,
      balance: 0,
      lifetimeEarned: 0,
      pending: 0,
      storyLikes: 0,
      storyViews: 0,
      reelLikes: 0,
      reelViews: 0,
      videoLikes: 0,
      videoViews: 0,
      referralPoints: 0,
      leaderboardPoints: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ================= REFERRAL REWARD =================

    if (referredBy) {
      await db.collection("wallets").updateOne(
        { user: referredBy },
        {
          $inc: {
            points: 10,
            referralPoints: 10,
          },
          $set: {
            updatedAt: new Date(),
          },
        }
      );
    }

    // ================= JWT =================

    const token = jwt.sign(
      { id: userId.toString() },
      env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    return json({
      message: "Registration successful",
      token,

      user: {
        _id: userId,
        name: userData.name,
        email: userData.email || "",
        phone: userData.phone || "",
        profilePic: "",
        role: userData.role || "user",
        referralCode,
      },
    }, 201);

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    return json({
      error: error.message,
    }, 500);
  }
}


// ================= LOGIN =================

export async function login(request, env, db) {
  try {
    

    const {
      identifier,
      password,
    } = await request.json();

    

    if (!identifier || !password) {
      return json({
        message: "Email/phone and password are required",
      }, 400);
    }

    const cleanIdentifier = identifier.trim();

    const isEmail = cleanIdentifier.includes("@");

    console.log("LOGIN: identifier type:", isEmail ? "email" : "phone");

    const user = await db.collection("users").findOne(
      isEmail
        ? {
            email: cleanIdentifier.toLowerCase(),
          }
        : {
            phone: cleanIdentifier,
          }
    );

    

    if (!user) {
      return json({
        message: "Invalid credentials",
      }, 400);
    }

    

    const match = await bcrypt.compare(
      password,
      user.password
    );

    console.log(
      "LOGIN: password comparison result:",
      match
    );

    if (!match) {
      return json({
        message: "Invalid credentials",
      }, 400);
    }

    

    if (
      ["requested", "pending", "processing", "review_required"].includes(
        String(user.deletionStatus || "").toLowerCase()
      )
    ) {
      return json({
        message: "This account has a pending deletion request.",
      }, 403);
    }

    // The deletion request is authoritative even if the user record
    // has not yet been synchronised.
    const deletionRequest = await db
      .collection("account_deletion_requests")
      .findOne({ userId: user._id });

    if (
      deletionRequest &&
      String(deletionRequest.status || "").toLowerCase() !== "cancelled"
    ) {
      return json({
        message: "This account has a pending deletion request.",
      }, 403);
    }

if (!env.JWT_SECRET) {
      throw new Error("JWT_SECRET is missing");
    }

    console.log(
      "LOGIN: JWT_SECRET exists:",
      !!env.JWT_SECRET
    );

    const token = jwt.sign(
      {
        id: user._id.toString(),
      },
      env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    console.log("LOGIN: JWT generated");

    return json({
      message: "Login successful",
      token,

      user: {
        _id: user._id,
        name: user.name,
        email: user.email || "",
        phone: user.phone || "",
        profilePic: user.profilePic || "",
        role: user.role || "user",
        referralCode: user.referralCode || "",
      },
    });

  } catch (error) {
    console.error(
      "LOGIN ERROR MESSAGE:",
      error?.message
    );

    console.error(
      "LOGIN ERROR STACK:",
      error?.stack
    );

    return json({
      error: error?.message || "Login failed",
    }, 500);
  }
}