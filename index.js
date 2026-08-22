// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import {
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var barbers = mysqlTable(
  "barbers",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    displayOrder: int("displayOrder").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [uniqueIndex("uniq_barbers_name").on(table.name)]
);
var services = mysqlTable(
  "services",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    priceInr: int("priceInr").notNull(),
    durationMinutes: int("durationMinutes").notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    displayOrder: int("displayOrder").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [uniqueIndex("uniq_services_name").on(table.name)]
);
var barberAvailability = mysqlTable(
  "barberAvailability",
  {
    id: int("id").autoincrement().primaryKey(),
    barberId: int("barberId").notNull().references(() => barbers.id),
    startsAt: timestamp("startsAt").notNull(),
    isAvailable: boolean("isAvailable").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("uniq_barber_availability_slot").on(table.barberId, table.startsAt),
    index("idx_barber_availability_starts_at").on(table.startsAt)
  ]
);
var appointmentStatus = ["pending", "completed", "cancelled"];
var appointments = mysqlTable(
  "appointments",
  {
    id: int("id").autoincrement().primaryKey(),
    clientId: int("clientId").notNull().references(() => users.id),
    barberId: int("barberId").notNull().references(() => barbers.id),
    serviceId: int("serviceId").notNull().references(() => services.id),
    startsAt: timestamp("startsAt").notNull(),
    status: mysqlEnum("status", appointmentStatus).default("pending").notNull(),
    serviceName: varchar("serviceName", { length: 120 }).notNull(),
    servicePriceInr: int("servicePriceInr").notNull(),
    activeSlotKey: varchar("activeSlotKey", { length: 120 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("uniq_appointments_active_slot").on(table.activeSlotKey),
    index("idx_appointments_barber_starts_at").on(table.barberId, table.startsAt),
    index("idx_appointments_client_starts_at").on(table.clientId, table.startsAt),
    index("idx_appointments_status_starts_at").on(table.status, table.startsAt)
  ]
);

// server/scribe.ts
var SLOT_MINUTES = 30;
var IST_OFFSET_MINUTES = 330;
var OPENING_HOUR = 10;
var CLOSING_HOUR = 20;
function slotStartInIst(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Select a valid appointment date and time.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day || minutes % SLOT_MINUTES !== 0 || hours < OPENING_HOUR || hours >= CLOSING_HOUR) {
    throw new Error("That time is outside Scribe booking hours.");
  }
  return new Date(localDate.getTime() - IST_OFFSET_MINUTES * 6e4);
}
function dayBoundsInIst(date) {
  const start = slotStartInIst(date, `${String(OPENING_HOUR).padStart(2, "0")}:00`);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 6e4)
  };
}
function timeSlots() {
  const slots = [];
  for (let minutes = OPENING_HOUR * 60; minutes < CLOSING_HOUR * 60; minutes += SLOT_MINUTES) {
    slots.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return slots;
}
function unbookedDaySlots(date, bookedStartsAt) {
  const booked = new Set(bookedStartsAt);
  return timeSlots().map((time) => slotStartInIst(date, time)).filter((startsAt) => !booked.has(startsAt.getTime()));
}
function appointmentSlotKey(barberId, startsAt) {
  return `${barberId}:${startsAt.getTime()}`;
}
function isActiveSlotConflict(error) {
  const databaseError = error;
  return databaseError?.errno === 1062 || String(databaseError?.message ?? error).includes("uniq_appointments_active_slot");
}
function activeSlotKeyForStatus(activeSlotKey, status) {
  return status === "cancelled" ? null : activeSlotKey;
}
function revenueSummary(appointments2, now = /* @__PURE__ */ new Date()) {
  const startOfIstDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - IST_OFFSET_MINUTES * 6e4
  );
  const startOfWeek = new Date(startOfIstDay);
  const weekday = (startOfWeek.getUTCDay() + 5) % 7;
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - weekday);
  const startOfMonth = new Date(startOfIstDay);
  startOfMonth.setUTCDate(1);
  const completed = appointments2.filter((appointment) => appointment.status === "completed");
  const totalFor = (start) => completed.filter((appointment) => appointment.startsAt >= start && appointment.startsAt <= now).reduce((total, appointment) => total + appointment.servicePriceInr, 0);
  return {
    dailyRevenueInr: totalFor(startOfIstDay),
    weeklyRevenueInr: totalFor(startOfWeek),
    monthlyRevenueInr: totalFor(startOfMonth),
    completedCount: completed.length,
    upcomingCount: appointments2.filter(
      (appointment) => appointment.status === "pending" && appointment.startsAt >= now
    ).length,
    completedByService: completed.reduce((summary, appointment) => {
      summary[appointment.serviceName] = (summary[appointment.serviceName] ?? 0) + appointment.servicePriceInr;
      return summary;
    }, {})
  };
}

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Scribe is temporarily unable to reach the booking database.");
  return db;
}
async function upsertUser(user) {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values = { openId: user.openId, lastSignedIn: /* @__PURE__ */ new Date() };
  const updateSet = { lastSignedIn: /* @__PURE__ */ new Date() };
  ["name", "email", "loginMethod"].forEach((field) => {
    if (user[field] !== void 0) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  });
  if (user.role !== void 0) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}
async function ensureScribeCatalog() {
  const db = await requireDb();
  await db.insert(barbers).values([
    { name: "Master Barber 01", title: "Precision cuts & classic form", displayOrder: 1 },
    { name: "Master Barber 02", title: "Modern fades & beard detail", displayOrder: 2 }
  ]).onDuplicateKeyUpdate({ set: { isActive: true } });
  await db.insert(services).values([
    { name: "Haircut", priceInr: 110, durationMinutes: 30, displayOrder: 1 },
    { name: "Haircut + Beard", priceInr: 200, durationMinutes: 30, displayOrder: 2 }
  ]).onDuplicateKeyUpdate({ set: { isActive: true } });
}
async function getScribeCatalog() {
  await ensureScribeCatalog();
  const db = await requireDb();
  const [barberRows, serviceRows] = await Promise.all([
    db.select().from(barbers).where(eq(barbers.isActive, true)).orderBy(asc(barbers.displayOrder)),
    db.select().from(services).where(eq(services.isActive, true)).orderBy(asc(services.displayOrder))
  ]);
  return { barbers: barberRows, services: serviceRows };
}
async function availableSlots(barberId, date) {
  await ensureScribeCatalog();
  const db = await requireDb();
  const { start, end } = dayBoundsInIst(date);
  const [bookedRows, availabilityRows] = await Promise.all([
    db.select({ startsAt: appointments.startsAt }).from(appointments).where(
      and(
        eq(appointments.barberId, barberId),
        inArray(appointments.status, ["pending", "completed"]),
        gte(appointments.startsAt, start),
        lt(appointments.startsAt, end)
      )
    ),
    db.select({ startsAt: barberAvailability.startsAt, isAvailable: barberAvailability.isAvailable }).from(barberAvailability).where(
      and(
        eq(barberAvailability.barberId, barberId),
        gte(barberAvailability.startsAt, start),
        lt(barberAvailability.startsAt, end)
      )
    )
  ]);
  const booked = new Set(bookedRows.map((row) => row.startsAt.getTime()));
  const blocked = new Set(
    availabilityRows.filter((row) => !row.isAvailable).map((row) => row.startsAt.getTime())
  );
  return timeSlots().filter((time) => {
    const slot = slotStartInIst(date, time).getTime();
    return !booked.has(slot) && !blocked.has(slot);
  });
}
var SlotUnavailableError = class extends Error {
  constructor() {
    super("That slot has just been reserved. Choose another available time.");
    this.name = "SlotUnavailableError";
  }
};
async function createAppointment(input) {
  await ensureScribeCatalog();
  const db = await requireDb();
  const [barber] = await db.select().from(barbers).where(and(eq(barbers.id, input.barberId), eq(barbers.isActive, true))).limit(1);
  const [service] = await db.select().from(services).where(and(eq(services.id, input.serviceId), eq(services.isActive, true))).limit(1);
  if (!barber || !service) throw new Error("The selected service or barber is no longer available.");
  const startsAt = slotStartInIst(input.date, input.time);
  if (startsAt <= /* @__PURE__ */ new Date()) throw new Error("Please select a future appointment time.");
  const [availabilityOverride] = await db.select({ isAvailable: barberAvailability.isAvailable }).from(barberAvailability).where(
    and(
      eq(barberAvailability.barberId, input.barberId),
      eq(barberAvailability.startsAt, startsAt)
    )
  ).limit(1);
  if (availabilityOverride && !availabilityOverride.isAvailable) throw new SlotUnavailableError();
  try {
    const result = await db.insert(appointments).values({
      clientId: input.clientId,
      barberId: input.barberId,
      serviceId: input.serviceId,
      startsAt,
      serviceName: service.name,
      servicePriceInr: service.priceInr,
      activeSlotKey: appointmentSlotKey(input.barberId, startsAt)
    });
    return { id: result[0].insertId, startsAt, serviceName: service.name, servicePriceInr: service.priceInr };
  } catch (error) {
    if (isActiveSlotConflict(error)) {
      throw new SlotUnavailableError();
    }
    throw error;
  }
}
async function getClientAppointments(clientId) {
  const db = await requireDb();
  return db.select({
    id: appointments.id,
    startsAt: appointments.startsAt,
    status: appointments.status,
    serviceName: appointments.serviceName,
    servicePriceInr: appointments.servicePriceInr,
    barberName: barbers.name
  }).from(appointments).innerJoin(barbers, eq(appointments.barberId, barbers.id)).where(eq(appointments.clientId, clientId)).orderBy(desc(appointments.startsAt));
}
async function getAdminAppointments() {
  const db = await requireDb();
  return db.select({
    id: appointments.id,
    startsAt: appointments.startsAt,
    status: appointments.status,
    serviceName: appointments.serviceName,
    servicePriceInr: appointments.servicePriceInr,
    clientName: users.name,
    clientEmail: users.email,
    barberName: barbers.name,
    barberId: appointments.barberId
  }).from(appointments).innerJoin(users, eq(appointments.clientId, users.id)).innerJoin(barbers, eq(appointments.barberId, barbers.id)).orderBy(desc(appointments.startsAt));
}
async function getClientOptions() {
  const db = await requireDb();
  return db.select({ id: users.id, name: users.name, email: users.email }).from(users).orderBy(asc(users.name));
}
async function getAdminSchedule(date) {
  const { barbers: barberRows } = await getScribeCatalog();
  const slots = await Promise.all(
    barberRows.map(async (barber) => ({
      barber,
      availableTimes: await availableSlots(barber.id, date)
    }))
  );
  return { date, slots, allTimes: timeSlots() };
}
async function setBarberSlotAvailability(input) {
  const db = await requireDb();
  const startsAt = slotStartInIst(input.date, input.time);
  await db.insert(barberAvailability).values({ barberId: input.barberId, startsAt, isAvailable: input.isAvailable }).onDuplicateKeyUpdate({ set: { isAvailable: input.isAvailable } });
  return { startsAt, isAvailable: input.isAvailable };
}
async function setBarberDayAvailability(input) {
  const db = await requireDb();
  const { start, end } = dayBoundsInIst(input.date);
  const [barber] = await db.select({ id: barbers.id }).from(barbers).where(and(eq(barbers.id, input.barberId), eq(barbers.isActive, true))).limit(1);
  if (!barber) throw new Error("That barber is not available.");
  const bookedRows = await db.select({ startsAt: appointments.startsAt }).from(appointments).where(
    and(
      eq(appointments.barberId, input.barberId),
      inArray(appointments.status, ["pending", "completed"]),
      gte(appointments.startsAt, start),
      lt(appointments.startsAt, end)
    )
  );
  const updates = unbookedDaySlots(input.date, bookedRows.map((row) => row.startsAt.getTime())).map((startsAt) => ({ barberId: input.barberId, startsAt, isAvailable: input.isAvailable }));
  if (updates.length) {
    await db.insert(barberAvailability).values(updates).onDuplicateKeyUpdate({ set: { isAvailable: input.isAvailable } });
  }
  return { updatedSlots: updates.length, preservedBookings: bookedRows.length };
}
async function updateAppointmentStatus(id, status) {
  const db = await requireDb();
  const [appointment] = await db.select({ activeSlotKey: appointments.activeSlotKey }).from(appointments).where(eq(appointments.id, id)).limit(1);
  if (!appointment) throw new Error("Appointment not found.");
  const values = { status, activeSlotKey: activeSlotKeyForStatus(appointment.activeSlotKey, status) };
  await db.update(appointments).set(values).where(eq(appointments.id, id));
}
function appointmentRevenueRows(rows) {
  return rows.map((row) => ({
    startsAt: row.startsAt,
    status: row.status,
    serviceName: row.serviceName,
    servicePriceInr: row.servicePriceInr
  }));
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/routers.ts
import { TRPCError as TRPCError3 } from "@trpc/server";
import { z as z2 } from "zod";

// server/adminAccess.ts
import { timingSafeEqual } from "node:crypto";
import { jwtVerify as jwtVerify2, SignJWT as SignJWT2 } from "jose";
import { parse } from "cookie";
var ADMIN_ACCESS_COOKIE = "scribe_admin_access";
var ADMIN_ACCESS_SCOPE = "scribe-admin-gate";
var encoder = new TextEncoder();
function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Admin access is unavailable because the session secret is missing.");
  return encoder.encode(`${secret}:${ADMIN_ACCESS_SCOPE}`);
}
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function verifyAdminCredentials(username, password) {
  const configuredUsername = process.env.SCRIBE_ADMIN_USERNAME;
  const configuredPassword = process.env.SCRIBE_ADMIN_PASSWORD;
  if (!configuredUsername || !configuredPassword) {
    throw new Error("Admin credentials have not been configured.");
  }
  return safeEqual(username, configuredUsername) && safeEqual(password, configuredPassword);
}
async function issueAdminAccessToken(openId) {
  return new SignJWT2({ scope: ADMIN_ACCESS_SCOPE }).setProtectedHeader({ alg: "HS256" }).setSubject(openId).setIssuedAt().setExpirationTime("8h").sign(signingKey());
}
async function verifyAdminAccessToken(token, openId) {
  try {
    const { payload } = await jwtVerify2(token, signingKey());
    return payload.scope === ADMIN_ACCESS_SCOPE && payload.sub === openId;
  } catch {
    return false;
  }
}
function getAdminAccessToken(cookieHeader) {
  return parse(cookieHeader ?? "")[ADMIN_ACCESS_COOKIE];
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
var dateInput = z2.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid calendar date.");
var timeInput = z2.string().regex(/^\d{2}:\d{2}$/, "Use a valid appointment time.");
var credentialInput = z2.object({ username: z2.string().min(1), password: z2.string().min(1) });
var gatedAdminProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const token = getAdminAccessToken(ctx.req.headers.cookie);
  const hasAccess = token && ctx.user ? await verifyAdminAccessToken(token, ctx.user.openId) : false;
  if (!hasAccess) {
    throw new TRPCError3({ code: "FORBIDDEN", message: "Admin username and password are required." });
  }
  return next();
});
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  scribe: router({
    catalog: publicProcedure.query(() => getScribeCatalog()),
    availability: publicProcedure.input(z2.object({ barberId: z2.number().int().positive(), date: dateInput })).query(({ input }) => availableSlots(input.barberId, input.date)),
    myAppointments: protectedProcedure.query(({ ctx }) => getClientAppointments(ctx.user.id)),
    book: protectedProcedure.input(
      z2.object({
        barberId: z2.number().int().positive(),
        serviceId: z2.number().int().positive(),
        date: dateInput,
        time: timeInput
      })
    ).mutation(async ({ ctx, input }) => {
      try {
        return await createAppointment({ ...input, clientId: ctx.user.id });
      } catch (error) {
        if (error instanceof SlotUnavailableError) {
          throw new TRPCError3({ code: "CONFLICT", message: error.message });
        }
        throw new TRPCError3({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Unable to save the appointment." });
      }
    })
  }),
  admin: router({
    access: adminProcedure.input(credentialInput).mutation(async ({ ctx, input }) => {
      if (!verifyAdminCredentials(input.username, input.password)) {
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "The admin username or password is incorrect." });
      }
      const token = await issueAdminAccessToken(ctx.user.openId);
      ctx.res.cookie(ADMIN_ACCESS_COOKIE, token, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: 8 * 60 * 60 * 1e3
      });
      return { success: true };
    }),
    accessStatus: adminProcedure.query(async ({ ctx }) => {
      const token = getAdminAccessToken(ctx.req.headers.cookie);
      return { hasAccess: token ? await verifyAdminAccessToken(token, ctx.user.openId) : false };
    }),
    appointments: gatedAdminProcedure.query(() => getAdminAppointments()),
    clients: gatedAdminProcedure.query(() => getClientOptions()),
    schedule: gatedAdminProcedure.input(z2.object({ date: dateInput })).query(({ input }) => getAdminSchedule(input.date)),
    overview: gatedAdminProcedure.query(async () => {
      const appointments2 = await getAdminAppointments();
      return revenueSummary(appointmentRevenueRows(appointments2));
    }),
    setAppointmentStatus: gatedAdminProcedure.input(z2.object({ id: z2.number().int().positive(), status: z2.enum(["pending", "completed", "cancelled"]) })).mutation(async ({ input }) => {
      await updateAppointmentStatus(input.id, input.status);
      return { success: true };
    }),
    setSlotAvailability: gatedAdminProcedure.input(
      z2.object({
        barberId: z2.number().int().positive(),
        date: dateInput,
        time: timeInput,
        isAvailable: z2.boolean()
      })
    ).mutation(({ input }) => setBarberSlotAvailability(input)),
    setDayAvailability: gatedAdminProcedure.input(z2.object({ barberId: z2.number().int().positive(), date: dateInput, isAvailable: z2.boolean() })).mutation(({ input }) => setBarberDayAvailability(input)),
    createAppointment: gatedAdminProcedure.input(
      z2.object({
        clientId: z2.number().int().positive(),
        barberId: z2.number().int().positive(),
        serviceId: z2.number().int().positive(),
        date: dateInput,
        time: timeInput
      })
    ).mutation(async ({ input }) => {
      try {
        return await createAppointment(input);
      } catch (error) {
        if (error instanceof SlotUnavailableError) {
          throw new TRPCError3({ code: "CONFLICT", message: error.message });
        }
        throw new TRPCError3({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Unable to add the appointment." });
      }
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
startServer().catch(console.error);
