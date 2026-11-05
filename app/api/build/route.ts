import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * 這個部署是哪一版 — for the client's build watcher (components/build-watch.tsx).
 *
 * The site deploys several times a day. A tab left open keeps the JavaScript
 * chunks of the build it loaded, and the next client-side navigation or lazy
 * chunk fetch asks the server for files that no longer exist: ChunkLoadError,
 * a dead page, a manual refresh. This answers "which build is live" in one
 * tiny request so the open tab can notice and reload itself.
 */
export async function GET() {
  return json({
    build:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.VERCEL_DEPLOYMENT_ID ??
      "dev",
  });
}
