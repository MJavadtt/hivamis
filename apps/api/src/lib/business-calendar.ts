/**
 * Business-hours arithmetic for the SLA engine.
 *
 * Doc_H states SLAs in working hours/days («۴ ساعت کاری», «۱ روز کاری»), so elapsed time must
 * exclude nights, weekends and holidays. The default calendar is the Iranian working week
 * (Saturday–Wednesday, 09:00–18:00 with one break hour); it is read from the organisation row
 * so a tenant can reconfigure it without a code change.
 */
export interface Calendar {
  workingDays: number[];
  startHour: number;
  endHour: number;
  breakHours: number;
  holidays: Set<string>;
}

export const DEFAULT_CALENDAR: Calendar = {
  workingDays: [6, 0, 1, 2, 3],
  startHour: 9,
  endHour: 18,
  breakHours: 1,
  holidays: new Set(),
};

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function isWorkingDay(d: Date, cal: Calendar): boolean {
  return cal.workingDays.includes(d.getDay()) && !cal.holidays.has(dayKey(d));
}

/** Productive hours in one working day (span minus the break). */
export function hoursPerDay(cal: Calendar): number {
  return cal.endHour - cal.startHour - cal.breakHours;
}

/** Move `d` forward to the next instant inside working hours (no-op if already inside). */
export function clampToWorking(d: Date, cal: Calendar): Date {
  const cur = new Date(d);
  for (let guard = 0; guard < 400; guard++) {
    if (!isWorkingDay(cur, cal)) {
      cur.setDate(cur.getDate() + 1);
      cur.setHours(cal.startHour, 0, 0, 0);
      continue;
    }
    const hour = cur.getHours() + cur.getMinutes() / 60;
    if (hour < cal.startHour) {
      cur.setHours(cal.startHour, 0, 0, 0);
      return cur;
    }
    if (hour >= cal.endHour) {
      cur.setDate(cur.getDate() + 1);
      cur.setHours(cal.startHour, 0, 0, 0);
      continue;
    }
    return cur;
  }
  return cur;
}

/** Add `hours` of *working* time to `from`, skipping non-working periods. */
export function addBusinessHours(from: Date, hours: number, cal: Calendar = DEFAULT_CALENDAR): Date {
  let cursor = clampToWorking(from, cal);
  let remaining = hours;
  for (let guard = 0; guard < 2000 && remaining > 0; guard++) {
    const endOfDay = new Date(cursor);
    endOfDay.setHours(cal.endHour, 0, 0, 0);
    const availableToday = (endOfDay.getTime() - cursor.getTime()) / 3_600_000;
    if (availableToday <= 0) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(cal.startHour, 0, 0, 0);
      cursor = clampToWorking(cursor, cal);
      continue;
    }
    if (remaining <= availableToday) {
      return new Date(cursor.getTime() + remaining * 3_600_000);
    }
    remaining -= availableToday;
    cursor = new Date(endOfDay);
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(cal.startHour, 0, 0, 0);
    cursor = clampToWorking(cursor, cal);
  }
  return cursor;
}

/** Working hours elapsed between two instants. */
export function businessHoursBetween(from: Date, to: Date, cal: Calendar = DEFAULT_CALENDAR): number {
  if (to <= from) return 0;
  let cursor = clampToWorking(from, cal);
  let total = 0;
  for (let guard = 0; guard < 2000 && cursor < to; guard++) {
    const endOfDay = new Date(cursor);
    endOfDay.setHours(cal.endHour, 0, 0, 0);
    const segmentEnd = to < endOfDay ? to : endOfDay;
    const delta = (segmentEnd.getTime() - cursor.getTime()) / 3_600_000;
    if (delta > 0) total += delta;
    cursor = new Date(endOfDay);
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(cal.startHour, 0, 0, 0);
    cursor = clampToWorking(cursor, cal);
  }
  return total;
}
