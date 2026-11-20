import {
  MEMBERSHIP_CHANNEL,
  encodeMembershipChange,
  type MembershipChange,
} from "@collabdocs/shared";
import { Redis } from "ioredis";

const globalForRedis = globalThis as unknown as { collabdocsRedis?: Redis };
let warned = false;

function publisher(url: string): Redis {
  if (!globalForRedis.collabdocsRedis) {
    const client = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
    // A Redis outage must not crash the web app; the publish below reports it per call.
    client.on("error", () => {});
    globalForRedis.collabdocsRedis = client;
  }
  return globalForRedis.collabdocsRedis;
}

/**
 * Tells the collab servers that a member's access changed, so they disconnect that
 * user's sockets at once instead of at token expiry.
 *
 * Call it after the database change has committed. It never throws: the change
 * itself has already happened, and the collab server re-checks memberships on a
 * timer, so a lost message delays the disconnect by at most that interval.
 */
export async function publishMembershipChange(change: MembershipChange): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (!warned) {
      warned = true;
      console.warn("REDIS_URL is not set; collab servers are not told about membership changes");
    }
    return;
  }
  try {
    await publisher(url).publish(MEMBERSHIP_CHANNEL, encodeMembershipChange(change));
  } catch (error) {
    console.error("could not publish a membership change", error);
  }
}
