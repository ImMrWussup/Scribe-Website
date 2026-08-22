import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { ADMIN_ACCESS_COOKIE, issueAdminAccessToken } from "./adminAccess";
import type { TrpcContext } from "./_core/context";

type CookieCall = { name: string; value: string; options: Record<string, unknown> };

function createAdminContext(): { ctx: TrpcContext; setCookies: CookieCall[] } {
  const setCookies: CookieCall[] = [];
  return {
    ctx: {
      user: {
        id: 1,
        openId: "scribe-owner",
        name: "Scribe Owner",
        email: "owner@example.com",
        loginMethod: "oauth",
        role: "admin",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: {
        cookie: (name: string, value: string, options: Record<string, unknown>) => setCookies.push({ name, value, options }),
      } as TrpcContext["res"],
    },
    setCookies,
  };
}

describe("admin credential access", () => {
  it("accepts the configured server-side credentials through the lightweight access endpoint", async () => {
    const username = process.env.SCRIBE_ADMIN_USERNAME;
    const password = process.env.SCRIBE_ADMIN_PASSWORD;
    expect(username).toBeTruthy();
    expect(password).toBeTruthy();

    const { ctx, setCookies } = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.admin.access({ username: username!, password: password! });

    expect(result).toEqual({ success: true });
    expect(setCookies[0]?.name).toBe(ADMIN_ACCESS_COOKIE);
    expect(setCookies[0]?.value).toBeTruthy();
    expect(setCookies[0]?.options).toMatchObject({ httpOnly: true, maxAge: 28_800_000 });
  });

  it("rejects an invalid password at the access endpoint", async () => {
    const username = process.env.SCRIBE_ADMIN_USERNAME;
    const { ctx } = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.access({ username: username!, password: "invalid" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("blocks gated admin data without the extra admin-access cookie", async () => {
    const { ctx } = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.appointments()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("recognizes a valid admin-access token tied to the current OAuth administrator", async () => {
    const token = await issueAdminAccessToken("scribe-owner");
    const { ctx } = createAdminContext();
    ctx.req.headers.cookie = `${ADMIN_ACCESS_COOKIE}=${token}`;
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.accessStatus()).resolves.toEqual({ hasAccess: true });
  });
});
