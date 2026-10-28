import { authenticate } from "../utils/auth.js";
import { getDatabase } from "../utils/db.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function listAdminAccountDeletions(request, env) {
  try {
    const userId = await authenticate(request, env);
    const db = await getDatabase(env);

    const admin = await db.collection("users").findOne(
      { _id: userId },
      { projection: { role: 1 } }
    );

    if (!admin || admin.role !== "admin") {
      return json({ success: false, message: "Admin access required." }, 403);
    }

    const url = new URL(request.url);
    const allowedStatuses = new Set([
      "pending",
      "processing",
      "review_required",
      "completed",
      "cancelled",
    ]);

    const requestedStatus = url.searchParams.get("status");
    const filter = {};

    if (requestedStatus && allowedStatuses.has(requestedStatus)) {
      filter.status = requestedStatus;
    }

    const page = Math.max(
      1,
      Math.min(100000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1)
    );

    const limit = Math.max(
      1,
      Math.min(100, Number.parseInt(url.searchParams.get("limit") || "25", 10) || 25)
    );

    const collection = db.collection("account_deletion_requests");

    const [total, records, statusCounts] = await Promise.all([
      collection.countDocuments(filter),
      collection.find(filter)
        .sort({ requestedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      Promise.all(
        [...allowedStatuses].map(async (status) => [
          status,
          await collection.countDocuments({ status }),
        ])
      ),
    ]);

    const now = Date.now();

    const requests = records.map((record) => {
      const requestedAt = record.requestedAt
        ? new Date(record.requestedAt)
        : null;

      const validRequestedAt =
        requestedAt && Number.isFinite(requestedAt.getTime());

      const graceDeadline = validRequestedAt
        ? new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
        : null;

      const financialReviewRequired =
        record.status === "review_required" ||
        record.financialReviewRequired === true ||
        (
          record.financialReviewStatus &&
          record.financialReviewStatus !== "cleared"
        );

      return {
        id: String(record._id),
        status: record.status || "unknown",
        requestedAt: validRequestedAt ? requestedAt.toISOString() : null,
        graceDeadline: graceDeadline ? graceDeadline.toISOString() : null,
        gracePeriodExpired: Boolean(
          graceDeadline &&
          now >= graceDeadline.getTime() &&
          record.status === "pending"
        ),
        financialReviewRequired,
        reviewReason: record.reviewReason || null,
        attempts: Number.isFinite(record.attempts) ? record.attempts : 0,
        updatedAt: record.updatedAt || null,
        completedAt: record.completedAt || null,
        cancelledAt: record.cancelledAt || null,
        cleanupProgress: record.cleanupProgress || null,
        lastError: record.lastError || null,
      };
    });

    const counts = Object.fromEntries(statusCounts);

    return json({
      success: true,
      requests,
      counts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      dryRun: {
        enabled: true,
        actualDeletionPerformed: false,
        eligibleForCleanupReview: requests.filter(
          (record) =>
            record.status === "pending" &&
            record.gracePeriodExpired &&
            !record.financialReviewRequired
        ).length,
        note:
          "This endpoint is read-only. Eligibility is a preliminary review, not authorization to delete data.",
      },
    });
  } catch (error) {
    const message = String(error?.message || "");

    if (
      message.includes("Authentication required") ||
      message.includes("Invalid token") ||
      message.includes("Invalid authentication token") ||
      message.includes("Token expired") ||
      message.includes("Invalid user ID")
    ) {
      return json(
        { success: false, message: "Please sign in with a valid account." },
        401
      );
    }

    console.error("ADMIN ACCOUNT DELETIONS ERROR:", error);

    return json(
      { success: false, message: "Unable to load account deletion requests." },
      500
    );
  }
}

/*
 * READ-ONLY ACCOUNT DELETION PREVIEW
 *
 * This handler never deletes, modifies, or schedules cleanup of data.
 * A successful preview is not authorisation to perform deletion.
 */

export async function previewAdminAccountDeletion(request, env) {
  try {
    const adminId = await authenticate(request, env);
    const db = await getDatabase(env);

    const admin = await db.collection("users").findOne(
      { _id: adminId },
      { projection: { role: 1 } }
    );

    if (!admin || admin.role !== "admin") {
      return json(
        { success: false, message: "Admin access required." },
        403
      );
    }

    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");

    if (!requestId || !/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return json(
        {
          success: false,
          message: "A valid deletion request ID is required."
        },
        400
      );
    }

    const { ObjectId } = await import("mongodb");
    const deletionRequest = await db
      .collection("account_deletion_requests")
      .findOne({ _id: new ObjectId(requestId) });

    if (!deletionRequest) {
      return json(
        { success: false, message: "Deletion request not found." },
        404
      );
    }

    if (
      !deletionRequest.userId ||
      !ObjectId.isValid(String(deletionRequest.userId))
    ) {
      return json({
        success: true,
        dryRun: true,
        actualDeletionPerformed: false,
        canProceed: false,
        eligibleForFurtherReview: false,
        message: "The request has an invalid or missing account owner.",
        checks: {
          requestOwnerValid: false
        }
      });
    }

    const userId = new ObjectId(String(deletionRequest.userId));
    const userIdString = userId.toString();
    const ownerValues = [userId, userIdString];
    const now = new Date();

    /*
     * Each database check fails independently. An unavailable
     * collection is never silently reported as having zero records.
     */
    async function safeCount(collectionName, filter) {
      try {
        const count = await db
          .collection(collectionName)
          .countDocuments(filter);

        return { available: true, count };
      } catch (error) {
        console.error(
          "ACCOUNT DELETION PREVIEW COUNT FAILED:",
          collectionName,
          error
        );

        return { available: false, count: null };
      }
    }

    async function safeFindOne(collectionName, filter, options = {}) {
      try {
        return {
          available: true,
          value: await db
            .collection(collectionName)
            .findOne(filter, options)
        };
      } catch (error) {
        console.error(
          "ACCOUNT DELETION PREVIEW LOOKUP FAILED:",
          collectionName,
          error
        );

        return { available: false, value: null };
      }
    }

    const requestedAt = deletionRequest.requestedAt
      ? new Date(deletionRequest.requestedAt)
      : null;

    const validRequestedAt = Boolean(
      requestedAt &&
      Number.isFinite(requestedAt.getTime()) &&
      requestedAt.getTime() <= now.getTime()
    );

    const graceDeadline = validRequestedAt
      ? new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
      : null;

    const gracePeriodExpired = Boolean(
      deletionRequest.status === "pending" &&
      graceDeadline &&
      now.getTime() >= graceDeadline.getTime()
    );

    const [
      accountResult,
      walletResult,
      pendingPaymentsResult,
      pendingTransactionsResult,
      postsResult,
      storiesResult,
      listingsResult,
      messagesResult,
      notificationsResult
    ] = await Promise.all([
      safeFindOne("users", { _id: userId }, {
        projection: { deletionStatus: 1 }
      }),

      safeFindOne("wallets", { user: userId }, {
        projection: {
          balance: 1,
          pending: 1,
          points: 1,
          lifetimeEarned: 1
        }
      }),

      safeCount("payments", {
        user: userId,
        $or: [
          { status: "pending" },
          { accountDeletionReviewRequired: true },
          { accountDeletionReviewStatus: "pending" },
          { status: "paid", activatedAt: null }
        ]
      }),

      safeCount("transactions", {
        user: { $in: ownerValues },
        status: {
          $in: [
            "pending",
            "processing",
            "initiated",
            "queued",
            "requires_review"
          ]
        }
      }),

      safeCount("posts", {
        user: { $in: ownerValues }
      }),

      safeCount("stories", {
        user: { $in: ownerValues }
      }),

      safeCount("marketplaces", {
        seller: { $in: ownerValues }
      }),

      safeCount("messages", {
        $or: [
          { sender: { $in: ownerValues } },
          { receiver: { $in: ownerValues } }
        ]
      }),

      safeCount("notifications", {
        recipient: { $in: ownerValues }
      })
    ]);

    const accountExists =
      accountResult.available && Boolean(accountResult.value);

    const accountStatusMatches = Boolean(
      accountExists &&
      accountResult.value.deletionStatus === deletionRequest.status
    );

    const wallet = walletResult.value;

    const readWalletValue = (field) => {
      if (!walletResult.available || !wallet) {
        return null;
      }

      const value = Number(wallet[field] ?? 0);
      return Number.isFinite(value) ? value : null;
    };

    const walletBalance = readWalletValue("balance");
    const walletPendingAmount = readWalletValue("pending");
    const walletPoints = readWalletValue("points");
    const lifetimeEarned = readWalletValue("lifetimeEarned");

    const walletValuesValid = Boolean(
      walletResult.available &&
      wallet &&
      [
        walletBalance,
        walletPendingAmount,
        walletPoints,
        lifetimeEarned
      ].every((value) => value !== null)
    );

    const walletHasOutstandingValue = Boolean(
      walletResult.available &&
      wallet &&
      (
        walletBalance === null ||
        walletPendingAmount === null ||
        walletPoints === null ||
        walletBalance !== 0 ||
        walletPendingAmount !== 0 ||
        walletPoints !== 0
      )
    );

    const knownFinancialChecksAvailable = Boolean(
      walletResult.available &&
      walletValuesValid &&
      pendingPaymentsResult.available &&
      pendingTransactionsResult.available
    );

    const financialReviewRequired = Boolean(
      deletionRequest.status === "review_required" ||
      deletionRequest.financialReviewRequired === true ||
      (
        deletionRequest.financialReviewStatus &&
        deletionRequest.financialReviewStatus !== "cleared"
      ) ||
      !knownFinancialChecksAvailable ||
      walletHasOutstandingValue ||
      (
        pendingPaymentsResult.available &&
        pendingPaymentsResult.count > 0
      ) ||
      (
        pendingTransactionsResult.available &&
        pendingTransactionsResult.count > 0
      )
    );

    const recordCounts = {
      posts: postsResult.count,
      stories: storiesResult.count,
      marketplaceListings: listingsResult.count,
      messagesInvolvingAccount: messagesResult.count,
      notifications: notificationsResult.count
    };

    const allRecordCountsAvailable = [
      postsResult,
      storiesResult,
      listingsResult,
      messagesResult,
      notificationsResult
    ].every((result) => result.available);

    const allRequiredQueriesAvailable = Boolean(
      accountResult.available &&
      walletResult.available &&
      pendingPaymentsResult.available &&
      pendingTransactionsResult.available &&
      allRecordCountsAvailable
    );

    const payoutSystemVerified = false;

    const blockers = [];

    if (!validRequestedAt) {
      blockers.push("The request date is missing, invalid, or in the future.");
    }

    if (deletionRequest.status !== "pending") {
      blockers.push("The request is not in pending status.");
    }

    if (!gracePeriodExpired) {
      blockers.push("The full 30-day grace period has not elapsed.");
    }

    if (!accountResult.available || !accountExists) {
      blockers.push("The account lookup failed or the account was not found.");
    }

    if (accountExists && !accountStatusMatches) {
      blockers.push("The account and deletion request statuses do not match.");
    }

    if (!allRequiredQueriesAvailable) {
      blockers.push("One or more required database checks are unavailable.");
    }

    if (financialReviewRequired) {
      blockers.push("Financial review is required or financial checks are incomplete.");
    }

    if (!payoutSystemVerified) {
      blockers.push("Pending payout obligations have not been independently verified.");
    }

    blockers.push(
      "Media references, KYC retention obligations, and all storage-provider cleanup requirements have not been fully verified."
    );

    return json({
      success: true,
      dryRun: true,
      actualDeletionPerformed: false,
      canProceed: false,
      eligibleForFurtherReview: Boolean(
        validRequestedAt &&
        gracePeriodExpired &&
        deletionRequest.status === "pending" &&
        accountExists &&
        accountStatusMatches &&
        allRequiredQueriesAvailable &&
        !financialReviewRequired &&
        payoutSystemVerified
      ),
      request: {
        id: String(deletionRequest._id),
        status: deletionRequest.status || "unknown",
        requestedAt: validRequestedAt
          ? requestedAt.toISOString()
          : null,
        graceDeadline: graceDeadline
          ? graceDeadline.toISOString()
          : null,
        gracePeriodExpired
      },
      financialReview: {
        required: financialReviewRequired,
        checksAvailable: knownFinancialChecksAvailable,
        walletRecordFound: Boolean(walletResult.available && wallet),
        walletBalance,
        walletPendingAmount,
        walletPoints,
        lifetimeEarned,
        walletHasOutstandingValue,
        pendingPayments: pendingPaymentsResult.count,
        unresolvedPayments: pendingPaymentsResult.count,
        pendingTransactions: pendingTransactionsResult.count,
        unresolvedTransactions: pendingTransactionsResult.count,
        payoutSystemVerified,
        note:
          "Unresolved payments require reconciliation but are not automatically money owed to the account holder. Lifetime earnings are historical and are not treated as outstanding liabilities. Payout verification remains incomplete until independently verified."
      },
      recordCounts,
      checks: {
        requestOwnerValid: true,
        accountLookupAvailable: accountResult.available,
        accountExists,
        accountStatusMatches,
        walletLookupAvailable: walletResult.available,
        paymentCheckAvailable: pendingPaymentsResult.available,
        transactionCheckAvailable: pendingTransactionsResult.available,
        postsCheckAvailable: postsResult.available,
        storiesCheckAvailable: storiesResult.available,
        marketplaceCheckAvailable: listingsResult.available,
        messagesCheckAvailable: messagesResult.available,
        notificationsCheckAvailable: notificationsResult.available,
        allRequiredQueriesAvailable,
        payoutSystemVerified,
        mediaReferencesFullyVerified: false,
        kycRetentionReviewed: false,
        storageCleanupVerified: false
      },
      blockers,
      note:
        "Read-only preview only. No data was deleted or modified. This result does not authorise account deletion or media cleanup."
    });
  } catch (error) {
    const message = String(error?.message || "");

    if (
      message.includes("Authentication required") ||
      message.includes("Invalid token") ||
      message.includes("Invalid authentication token") ||
      message.includes("Token expired") ||
      message.includes("Invalid user ID")
    ) {
      return json(
        {
          success: false,
          message: "Please sign in with a valid account."
        },
        401
      );
    }

    console.error("ADMIN ACCOUNT DELETION PREVIEW ERROR:", error);

    return json(
      {
        success: false,
        message: "Unable to generate the account deletion preview."
      },
      500
    );
  }
}
