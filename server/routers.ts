import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ADMIN_ACCESS_COOKIE,
  getAdminAccessToken,
  issueAdminAccessToken,
  verifyAdminAccessToken,
  verifyAdminCredentials,
} from "./adminAccess";
import {
  availableSlots,
  appointmentRevenueRows,
  createAppointment,
  getAdminAppointments,
  getClientOptions,
  getAdminSchedule,
  getClientAppointments,
  getScribeCatalog,
  setBarberDayAvailability,
  setBarberSlotAvailability,
  SlotUnavailableError,
  updateAppointmentStatus,
} from "./db";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { revenueSummary } from "./scribe";
import { COOKIE_NAME } from "@shared/const";

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid calendar date.");
const timeInput = z.string().regex(/^\d{2}:\d{2}$/, "Use a valid appointment time.");
const credentialInput = z.object({ username: z.string().min(1), password: z.string().min(1) });

const gatedAdminProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const token = getAdminAccessToken(ctx.req.headers.cookie);
  const hasAccess = token && ctx.user ? await verifyAdminAccessToken(token, ctx.user.openId) : false;
  if (!hasAccess) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin username and password are required." });
  }
  return next();
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  scribe: router({
    catalog: publicProcedure.query(() => getScribeCatalog()),
    availability: publicProcedure
      .input(z.object({ barberId: z.number().int().positive(), date: dateInput }))
      .query(({ input }) => availableSlots(input.barberId, input.date)),
    myAppointments: protectedProcedure.query(({ ctx }) => getClientAppointments(ctx.user.id)),
    book: protectedProcedure
      .input(
        z.object({
          barberId: z.number().int().positive(),
          serviceId: z.number().int().positive(),
          date: dateInput,
          time: timeInput,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await createAppointment({ ...input, clientId: ctx.user.id });
        } catch (error) {
          if (error instanceof SlotUnavailableError) {
            throw new TRPCError({ code: "CONFLICT", message: error.message });
          }
          throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Unable to save the appointment." });
        }
      }),
  }),
  admin: router({
    access: adminProcedure.input(credentialInput).mutation(async ({ ctx, input }) => {
      if (!verifyAdminCredentials(input.username, input.password)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "The admin username or password is incorrect." });
      }
      const token = await issueAdminAccessToken(ctx.user.openId);
      ctx.res.cookie(ADMIN_ACCESS_COOKIE, token, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: 8 * 60 * 60 * 1000,
      });
      return { success: true } as const;
    }),
    accessStatus: adminProcedure.query(async ({ ctx }) => {
      const token = getAdminAccessToken(ctx.req.headers.cookie);
      return { hasAccess: token ? await verifyAdminAccessToken(token, ctx.user.openId) : false };
    }),
    appointments: gatedAdminProcedure.query(() => getAdminAppointments()),
    clients: gatedAdminProcedure.query(() => getClientOptions()),
    schedule: gatedAdminProcedure.input(z.object({ date: dateInput })).query(({ input }) => getAdminSchedule(input.date)),
    overview: gatedAdminProcedure.query(async () => {
      const appointments = await getAdminAppointments();
      return revenueSummary(appointmentRevenueRows(appointments));
    }),
    setAppointmentStatus: gatedAdminProcedure
      .input(z.object({ id: z.number().int().positive(), status: z.enum(["pending", "completed", "cancelled"]) }))
      .mutation(async ({ input }) => {
        await updateAppointmentStatus(input.id, input.status);
        return { success: true } as const;
      }),
    setSlotAvailability: gatedAdminProcedure
      .input(
        z.object({
          barberId: z.number().int().positive(),
          date: dateInput,
          time: timeInput,
          isAvailable: z.boolean(),
        }),
      )
      .mutation(({ input }) => setBarberSlotAvailability(input)),
    setDayAvailability: gatedAdminProcedure
      .input(z.object({ barberId: z.number().int().positive(), date: dateInput, isAvailable: z.boolean() }))
      .mutation(({ input }) => setBarberDayAvailability(input)),
    createAppointment: gatedAdminProcedure
      .input(
        z.object({
          clientId: z.number().int().positive(),
          barberId: z.number().int().positive(),
          serviceId: z.number().int().positive(),
          date: dateInput,
          time: timeInput,
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return await createAppointment(input);
        } catch (error) {
          if (error instanceof SlotUnavailableError) {
            throw new TRPCError({ code: "CONFLICT", message: error.message });
          }
          throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Unable to add the appointment." });
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
