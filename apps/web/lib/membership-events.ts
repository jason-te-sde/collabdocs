import { MEMBERSHIP_CHANNEL, type MembershipChange } from "@collabdocs/shared";
import { MIN_REDIS_SECRET_BYTES, sealMembershipChange } from "@collabdocs/shared/redis-auth";
import { getRedis } from "@/lib/redis";

let warned = false;
let warnedSecret = false;

/**
 * Tells the collab servers that a member's access changed, so they disconnect that
 * user's sockets at once instead of at token expiry.
 *
 * Call it after the database change has committed. It never throws: the change
 * itself has already happened, and the collab server re-checks memberships on a
 * timer, so a lost message delays the disconnect by at most that interval.
 */
export async function publishMembershipChange(change: MembershipChange): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    if (!warned) {
      warned = true;
      console.warn("REDIS_URL is not set; collab servers are not told about membership changes");
    }
    return;
  }
  // The collab servers act only on a message signed with this secret.
  const secret = process.env.REDIS_MESSAGE_SECRET;
  if (!secret || new TextEncoder().encode(secret).length < MIN_REDIS_SECRET_BYTES) {
    if (!warnedSecret) {
      warnedSecret = true;
      console.error(
        `REDIS_MESSAGE_SECRET is missing or shorter than ${MIN_REDIS_SECRET_BYTES} bytes; membership changes are not published`,
      );
    }
    return;
  }
  try {
    await redis.publish(MEMBERSHIP_CHANNEL, sealMembershipChange(change, secret));
  } catch (error) {
    console.error("could not publish a membership change", error);
  }
}
