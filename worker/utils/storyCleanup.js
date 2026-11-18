import { withFreshDatabase } from "./db.js";
import { getStoryMediaKeys, isOwnedStoryMediaKey } from "./storyMedia.js";

const CLEANUP_LEASE_MS = 10 * 60 * 1000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mediaReferenceFilter(key) {
  const rawKey = escapeRegExp(key);
  const encodedKey = escapeRegExp(encodeURIComponent(key));
  const urlPatterns = [
    new RegExp(`${rawKey}$`, "i"),
    new RegExp(`${encodedKey}$`, "i"),
  ];

  return {
    $or: [
      { "media.key": key },
      { "media.thumbnailKey": key },
      ...urlPatterns.flatMap((pattern) => [
        { "media.url": pattern },
        { "media.thumbnailUrl": pattern },
      ]),
    ],
  };
}

export async function cleanupExpiredStories(
  env,
  databaseRunner = withFreshDatabase
) {
  if (!env.MEDIA_BUCKET) {
    throw new Error("MEDIA_BUCKET is not configured");
  }

  const now = new Date();

  return databaseRunner(env, async (db) => {
    const stories = db.collection("stories");
    const posts = db.collection("posts");

    const expiredStories = await stories
      .find({ expiresAt: { $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(50)
      .toArray();

    const stats = {
      checked: expiredStories.length,
      claimedStories: 0,
      deletedStories: 0,
      deletedObjects: 0,
      failedStories: 0,
      protectedObjects: 0,
      skippedStories: 0,
    };

    for (const story of expiredStories) {
      const token = crypto.randomUUID();
      const leaseExpiry = new Date(Date.now() + CLEANUP_LEASE_MS);

      // Claim atomically. Active Story-sharing reservations prevent cleanup.
      const claim = await stories.updateOne(
        {
          _id: story._id,
          expiresAt: { $lte: now },
          $or: [
            { "cleanupLease.expiresAt": { $exists: false } },
            { "cleanupLease.expiresAt": { $lte: now } },
          ],
          shareReservations: {
            $not: {
              $elemMatch: {
                expiresAt: { $gt: now },
              },
            },
          },
        },
        {
          $set: {
            cleanupLease: {
              token,
              expiresAt: leaseExpiry,
            },
          },
        }
      );

      if (claim.modifiedCount !== 1) {
        stats.skippedStories++;
        continue;
      }

      stats.claimedStories++;

      const releaseLease = async () => {
        await stories.updateOne(
          {
            _id: story._id,
            "cleanupLease.token": token,
          },
          {
            $unset: {
              cleanupLease: "",
            },
          }
        );
      };

      try {
        const ownerId =
          story.user &&
          typeof story.user === "object" &&
          story.user._id
            ? String(story.user._id)
            : String(story.user ?? "");

        const media = Array.isArray(story.media)
          ? story.media
          : [];

          const keys = new Set(getStoryMediaKeys(media));
          let safeToDelete = true;

          for (const key of keys) {
            if (!isOwnedStoryMediaKey(key, ownerId)) {
              console.error(
                "[STORY CLEANUP] Invalid media key; retaining Story",
                story._id
              );
              safeToDelete = false;
              break;
            }
          }

        if (!safeToDelete) {
          stats.failedStories++;
          await releaseLease();
          continue;
        }

        for (const key of keys) {
          // Protect media still referenced by another Story.
          const storyReference = await stories.findOne(
            {
              _id: { $ne: story._id },
              ...mediaReferenceFilter(key),
            },
            { projection: { _id: 1 } }
          );

          // Protect media copied into an ordinary or shared Post.
          const postReference = await posts.findOne(
            mediaReferenceFilter(key),
            { projection: { _id: 1 } }
          );

          if (storyReference || postReference) {
            stats.protectedObjects++;
            continue;
          }

          try {
            await env.MEDIA_BUCKET.delete(key);
            stats.deletedObjects++;
          } catch (error) {
            console.error(
              "[STORY CLEANUP] R2 deletion failed:",
              key,
              error
            );

            safeToDelete = false;
            break;
          }
        }

        if (!safeToDelete) {
          stats.failedStories++;
          await releaseLease();
          continue;
        }

        const result = await stories.deleteOne({
          _id: story._id,
          expiresAt: { $lte: now },
          "cleanupLease.token": token,
        });

        if (result.deletedCount === 1) {
          stats.deletedStories++;
        } else {
          await releaseLease();
          stats.skippedStories++;
        }
      } catch (error) {
        console.error(
          "[STORY CLEANUP] Story processing failed:",
          story._id,
          error
        );

        stats.failedStories++;

        try {
          await releaseLease();
        } catch (releaseError) {
          console.error(
            "[STORY CLEANUP] Failed to release cleanup lease:",
            story._id,
            releaseError
          );
        }
      }
    }

    console.log("[STORY CLEANUP] Completed:", stats);
    return stats;
  });
}
