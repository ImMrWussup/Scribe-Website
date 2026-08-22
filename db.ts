import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  Appointment,
  appointmentStatus,
  appointments,
  barberAvailability,
  barbers,
  InsertUser,
  services,
  users,
} from "../drizzle/schema";
import { activeSlotKeyForStatus, appointmentSlotKey, dayBoundsInIst, isActiveSlotConflict, slotStartInIst, timeSlots, unbookedDaySlots } from "./scribe";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
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

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");

  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId, lastSignedIn: new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: new Date() };
  (["name", "email", "loginMethod"] as const).forEach(field => {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  });

  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function ensureScribeCatalog() {
  const db = await requireDb();
  await db
    .insert(barbers)
    .values([
      { name: "Master Barber 01", title: "Precision cuts & classic form", displayOrder: 1 },
      { name: "Master Barber 02", title: "Modern fades & beard detail", displayOrder: 2 },
    ])
    .onDuplicateKeyUpdate({ set: { isActive: true } });
  await db
    .insert(services)
    .values([
      { name: "Haircut", priceInr: 110, durationMinutes: 30, displayOrder: 1 },
      { name: "Haircut + Beard", priceInr: 200, durationMinutes: 30, displayOrder: 2 },
    ])
    .onDuplicateKeyUpdate({ set: { isActive: true } });
}

export async function getScribeCatalog() {
  await ensureScribeCatalog();
  const db = await requireDb();
  const [barberRows, serviceRows] = await Promise.all([
    db.select().from(barbers).where(eq(barbers.isActive, true)).orderBy(asc(barbers.displayOrder)),
    db.select().from(services).where(eq(services.isActive, true)).orderBy(asc(services.displayOrder)),
  ]);
  return { barbers: barberRows, services: serviceRows };
}

export async function availableSlots(barberId: number, date: string) {
  await ensureScribeCatalog();
  const db = await requireDb();
  const { start, end } = dayBoundsInIst(date);
  const [bookedRows, availabilityRows] = await Promise.all([
    db
      .select({ startsAt: appointments.startsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.barberId, barberId),
          inArray(appointments.status, ["pending", "completed"]),
          gte(appointments.startsAt, start),
          lt(appointments.startsAt, end),
        ),
      ),
    db
      .select({ startsAt: barberAvailability.startsAt, isAvailable: barberAvailability.isAvailable })
      .from(barberAvailability)
      .where(
        and(
          eq(barberAvailability.barberId, barberId),
          gte(barberAvailability.startsAt, start),
          lt(barberAvailability.startsAt, end),
        ),
      ),
  ]);

  const booked = new Set(bookedRows.map(row => row.startsAt.getTime()));
  const blocked = new Set(
    availabilityRows.filter(row => !row.isAvailable).map(row => row.startsAt.getTime()),
  );
  return timeSlots().filter(time => {
    const slot = slotStartInIst(date, time).getTime();
    return !booked.has(slot) && !blocked.has(slot);
  });
}

export class SlotUnavailableError extends Error {
  constructor() {
    super("That slot has just been reserved. Choose another available time.");
    this.name = "SlotUnavailableError";
  }
}

export async function createAppointment(input: {
  clientId: number;
  barberId: number;
  serviceId: number;
  date: string;
  time: string;
}) {
  await ensureScribeCatalog();
  const db = await requireDb();
  const [barber] = await db.select().from(barbers).where(and(eq(barbers.id, input.barberId), eq(barbers.isActive, true))).limit(1);
  const [service] = await db.select().from(services).where(and(eq(services.id, input.serviceId), eq(services.isActive, true))).limit(1);
  if (!barber || !service) throw new Error("The selected service or barber is no longer available.");

  const startsAt = slotStartInIst(input.date, input.time);
  if (startsAt <= new Date()) throw new Error("Please select a future appointment time.");

  const [availabilityOverride] = await db
    .select({ isAvailable: barberAvailability.isAvailable })
    .from(barberAvailability)
    .where(
      and(
        eq(barberAvailability.barberId, input.barberId),
        eq(barberAvailability.startsAt, startsAt),
      ),
    )
    .limit(1);
  if (availabilityOverride && !availabilityOverride.isAvailable) throw new SlotUnavailableError();

  try {
    const result = await db.insert(appointments).values({
      clientId: input.clientId,
      barberId: input.barberId,
      serviceId: input.serviceId,
      startsAt,
      serviceName: service.name,
      servicePriceInr: service.priceInr,
      activeSlotKey: appointmentSlotKey(input.barberId, startsAt),
    });
    return { id: result[0].insertId, startsAt, serviceName: service.name, servicePriceInr: service.priceInr };
  } catch (error) {
    if (isActiveSlotConflict(error)) {
      throw new SlotUnavailableError();
    }
    throw error;
  }
}

export async function getClientAppointments(clientId: number) {
  const db = await requireDb();
  return db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      status: appointments.status,
      serviceName: appointments.serviceName,
      servicePriceInr: appointments.servicePriceInr,
      barberName: barbers.name,
    })
    .from(appointments)
    .innerJoin(barbers, eq(appointments.barberId, barbers.id))
    .where(eq(appointments.clientId, clientId))
    .orderBy(desc(appointments.startsAt));
}

export async function getAdminAppointments() {
  const db = await requireDb();
  return db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      status: appointments.status,
      serviceName: appointments.serviceName,
      servicePriceInr: appointments.servicePriceInr,
      clientName: users.name,
      clientEmail: users.email,
      barberName: barbers.name,
      barberId: appointments.barberId,
    })
    .from(appointments)
    .innerJoin(users, eq(appointments.clientId, users.id))
    .innerJoin(barbers, eq(appointments.barberId, barbers.id))
    .orderBy(desc(appointments.startsAt));
}

export async function getClientOptions() {
  const db = await requireDb();
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .orderBy(asc(users.name));
}

export async function getAdminSchedule(date: string) {
  const { barbers: barberRows } = await getScribeCatalog();
  const slots = await Promise.all(
    barberRows.map(async barber => ({
      barber,
      availableTimes: await availableSlots(barber.id, date),
    })),
  );
  return { date, slots, allTimes: timeSlots() };
}

export async function setBarberSlotAvailability(input: {
  barberId: number;
  date: string;
  time: string;
  isAvailable: boolean;
}) {
  const db = await requireDb();
  const startsAt = slotStartInIst(input.date, input.time);
  await db
    .insert(barberAvailability)
    .values({ barberId: input.barberId, startsAt, isAvailable: input.isAvailable })
    .onDuplicateKeyUpdate({ set: { isAvailable: input.isAvailable } });
  return { startsAt, isAvailable: input.isAvailable };
}

/** Sets an entire day while preserving booked appointments as occupied schedule slots. */
export async function setBarberDayAvailability(input: {
  barberId: number;
  date: string;
  isAvailable: boolean;
}) {
  const db = await requireDb();
  const { start, end } = dayBoundsInIst(input.date);
  const [barber] = await db
    .select({ id: barbers.id })
    .from(barbers)
    .where(and(eq(barbers.id, input.barberId), eq(barbers.isActive, true)))
    .limit(1);
  if (!barber) throw new Error("That barber is not available.");

  const bookedRows = await db
    .select({ startsAt: appointments.startsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.barberId, input.barberId),
        inArray(appointments.status, ["pending", "completed"]),
        gte(appointments.startsAt, start),
        lt(appointments.startsAt, end),
      ),
    );
  const updates = unbookedDaySlots(input.date, bookedRows.map(row => row.startsAt.getTime()))
    .map(startsAt => ({ barberId: input.barberId, startsAt, isAvailable: input.isAvailable }));

  if (updates.length) {
    await db.insert(barberAvailability).values(updates).onDuplicateKeyUpdate({ set: { isAvailable: input.isAvailable } });
  }

  return { updatedSlots: updates.length, preservedBookings: bookedRows.length };
}

export async function updateAppointmentStatus(id: number, status: (typeof appointmentStatus)[number]) {
  const db = await requireDb();
  const [appointment] = await db
    .select({ activeSlotKey: appointments.activeSlotKey })
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);
  if (!appointment) throw new Error("Appointment not found.");
  const values = { status, activeSlotKey: activeSlotKeyForStatus(appointment.activeSlotKey, status) };
  await db.update(appointments).set(values).where(eq(appointments.id, id));
}

export function appointmentRevenueRows(rows: Awaited<ReturnType<typeof getAdminAppointments>>) {
  return rows.map(row => ({
    startsAt: row.startsAt,
    status: row.status,
    serviceName: row.serviceName,
    servicePriceInr: row.servicePriceInr,
  })) as Array<Pick<Appointment, "startsAt" | "status" | "serviceName" | "servicePriceInr">>;
}
