import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { env } from "../../shared/env.js";
import { withChrome } from "./_helpers.js";

export async function aboutRoutes(app: FastifyInstance) {
  app.get("/about", async (req, reply) => {
    let dbOk = true;
    let counts = {
      libraries: 0,
      users: 0,
      books: 0,
      copies: 0,
      trophies: 0,
      completions: 0,
      auditLog: 0,
    };
    let library: Awaited<ReturnType<typeof prisma.library.findFirst>> = null;
    try {
      const [libraries, users, books, copies, trophies, completions, auditLog, lib] = await Promise.all([
        prisma.library.count(),
        prisma.user.count(),
        prisma.book.count(),
        prisma.physicalCopy.count(),
        prisma.trophy.count(),
        prisma.completion.count(),
        prisma.auditLog.count(),
        prisma.library.findFirst({ orderBy: { createdAt: "asc" } }),
      ]);
      counts = { libraries, users, books, copies, trophies, completions, auditLog };
      library = lib;
    } catch {
      dbOk = false;
    }

    return reply.view(
      "about.ejs",
      await withChrome(req, {
        gitSha: env.GIT_SHA,
        imageTag: env.IMAGE_TAG,
        nodeVersion: process.version,
        uptimeSec: Math.round(process.uptime()),
        dbOk,
        counts,
        library,
        webBaseUrl: env.WEB_BASE_URL ?? null,
        repoUrl: "https://github.com/stevenob/paper-hoard",
        ghcrUrl: "https://github.com/stevenob/paper-hoard/pkgs/container/paper-hoard",
      })
    );
  });
}
