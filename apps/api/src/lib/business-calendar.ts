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

/**
 * The instant a working day stops accruing productive time.
 *
 * BREAK MODEL — the organisation row stores `breakHours` as a duration, not a window, so the
 * break has no wall-clock position. It is therefore modelled at the END of the working span:
 * with 09:00–18:00 and one break hour, productive time is 09:00–17:00 and the last hour is
 * not counted. Any fixed position gives the same total per day; placing it at the end keeps
 * addBusinessHours and businessHoursBetween exact inverses and needs no schema change.
 *
 * Both functions previously measured the full 09:00–18:00 span, so a "1 working day" (8h) SLA
 * started at 09:00 came due at 17:00 the SAME day instead of the next working morning — and the
 * error compounded on multi-day policies like SLA_CONTRACT_DRAFT (3d) and SLA_FEEDBACK (7d).
 */
function productiveEndOfDay(d: Date, cal: Calendar): Date {
  const end = new Date(d);
  const h = cal.startHour + hoursPerDay(cal);
  end.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  return end;
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
    // Past the productive window, not merely past closing time — see productiveEndOfDay.
    if (hour >= cal.startHour + hoursPerDay(cal)) {
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
    const endOfDay = productiveEndOfDay(cursor, cal);
    const availableToday = (endOfDay.getTime() - cursor.getTime()) / 3_600_000;
    if (availableToday <= 0) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(cal.startHour, 0, 0, 0);
      cursor = clampToWorking(cursor, cal);
      continue;
    }
    // Strictly less: a budget that exactly consumes the rest of the day rolls to the next
    // working morning rather than landing on the closing instant, so a due date is always a
    // moment the office is actually open.
    if (remaining < availableToday) {
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
    const endOfDay = productiveEndOfDay(cursor, cal);
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
