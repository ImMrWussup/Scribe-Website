import { describe, expect, it } from "vitest";
import { activeSlotKeyForStatus, appointmentSlotKey, isActiveSlotConflict, revenueSummary, slotStartInIst, timeSlots, unbookedDaySlots } from "./scribe";

describe("Scribe booking rules", () => {
  it("converts a valid Indian appointment time to a stable UTC slot key", () => {
    const startsAt = slotStartInIst("2026-08-24", "10:00");
    expect(startsAt.toISOString()).toBe("2026-08-24T04:30:00.000Z");
    expect(appointmentSlotKey(2, startsAt)).toBe("2:1787545800000");
  });

  it("offers only thirty-minute slots within operating hours", () => {
    expect(timeSlots()).toHaveLength(20);
    expect(timeSlots()[0]).toBe("10:00");
    expect(timeSlots().at(-1)).toBe("19:30");
    expect(() => slotStartInIst("2026-08-24", "09:30")).toThrow("outside Scribe booking hours");
  });

  it("excludes booked appointments from a barber’s day-level availability update", () => {
    const booked = slotStartInIst("2026-08-24", "12:00");
    const slots = unbookedDaySlots("2026-08-24", [booked.getTime()]);
    expect(slots).toHaveLength(19);
    expect(slots.map(slot => slot.getTime())).not.toContain(booked.getTime());
  });

  it("recognizes the active-slot uniqueness error created by simultaneous reservations", () => {
    expect(isActiveSlotConflict({ errno: 1062 })).toBe(true);
    expect(isActiveSlotConflict(new Error("Duplicate entry for key 'uniq_appointments_active_slot'"))).toBe(true);
    expect(isActiveSlotConflict(new Error("connection reset"))).toBe(false);
  });

  it("releases a cancelled appointment slot but preserves completed and pending appointments", () => {
    const activeSlotKey = "1:1787545800000";
    expect(activeSlotKeyForStatus(activeSlotKey, "pending")).toBe(activeSlotKey);
    expect(activeSlotKeyForStatus(activeSlotKey, "completed")).toBe(activeSlotKey);
    expect(activeSlotKeyForStatus(activeSlotKey, "cancelled")).toBeNull();
  });

  it("counts completed revenue without including cancelled or pending appointments", () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const summary = revenueSummary(
      [
        { startsAt: new Date("2026-08-24T08:00:00.000Z"), status: "completed", serviceName: "Haircut", servicePriceInr: 110 },
        { startsAt: new Date("2026-08-24T09:00:00.000Z"), status: "completed", serviceName: "Haircut + Beard", servicePriceInr: 200 },
        { startsAt: new Date("2026-08-24T10:00:00.000Z"), status: "cancelled", serviceName: "Haircut", servicePriceInr: 110 },
        { startsAt: new Date("2026-08-25T04:30:00.000Z"), status: "pending", serviceName: "Haircut", servicePriceInr: 110 },
      ],
      now,
    );

    expect(summary.dailyRevenueInr).toBe(310);
    expect(summary.weeklyRevenueInr).toBe(310);
    expect(summary.monthlyRevenueInr).toBe(310);
    expect(summary.completedByService).toEqual({ Haircut: 110, "Haircut + Beard": 200 });
    expect(summary.upcomingCount).toBe(1);
  });
});
