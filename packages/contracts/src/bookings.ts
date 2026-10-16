import { z } from 'zod';
import { idSchema } from './schemas.js';

/**
 * Booking rooms, equipment, parking and vehicles for a meeting (audit F-9, step 2): the Telegram
 * meeting platform's domain, brought into Hivamis. Every row carries its organisation; states move
 * only through the workflow engine; and the database itself refuses two bookings of one room, or of
 * one person, at the same time.
 */

export const RESOURCE_TYPES = ['ROOM', 'EQUIPMENT', 'PARKING', 'VEHICLE', 'OTHER'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export const RESOURCE_TYPE_LABELS: Record<ResourceType, { fa: string; en: string }> = {
  ROOM: { fa: 'اتاق جلسه', en: 'Meeting room' },
  EQUIPMENT: { fa: 'تجهیزات', en: 'Equipment' },
  PARKING: { fa: 'پارکینگ', en: 'Parking' },
  VEHICLE: { fa: 'خودرو', en: 'Vehicle' },
  OTHER: { fa: 'سایر', en: 'Other' },
};

/** What a room offers; the booking form filters by it. */
export const RESOURCE_FEATURES = ['VIDEO_CONFERENCE', 'DISPLAY', 'WHITEBOARD', 'CAMERA', 'MICROPHONE', 'ACCESSIBLE'] as const;
export type ResourceFeature = (typeof RESOURCE_FEATURES)[number];
export const RESOURCE_FEATURE_LABELS: Record<ResourceFeature, { fa: string; en: string }> = {
  VIDEO_CONFERENCE: { fa: 'ویدئوکنفرانس', en: 'Video conference' },
  DISPLAY: { fa: 'نمایشگر', en: 'Display' },
  WHITEBOARD: { fa: 'تخته', en: 'Whiteboard' },
  CAMERA: { fa: 'دوربین', en: 'Camera' },
  MICROPHONE: { fa: 'میکروفون', en: 'Microphone' },
  ACCESSIBLE: { fa: 'دسترس‌پذیر', en: 'Accessible' },
};

export const BOOKING_KINDS = ['INTERNAL', 'EXTERNAL'] as const;
/** A booking longer than this is a mistake, not a meeting. */
export const BOOKING_MAX_HOURS = 12;

export const bookingLocationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['INSIDE', 'OUTSIDE']).default('INSIDE'),
  address: z.string().trim().max(400).optional(),
  building: z.string().trim().max(120).optional(),
  isActive: z.boolean().default(true),
});

export const bookableResourceSchema = z.object({
  type: z.enum(RESOURCE_TYPES),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional(),
  locationId: idSchema.nullish(),
  /** Seats for a room, spaces for parking; one for anything booked whole. */
  capacity: z.number().int().min(0).max(10_000).default(1),
  floor: z.string().trim().max(40).optional(),
  features: z.array(z.enum(RESOURCE_FEATURES)).max(RESOURCE_FEATURES.length).default([]),
  isActive: z.boolean().default(true),
});

export const cateringOptionSchema = z.object({
  labelFa: z.string().trim().min(2).max(80),
  labelEn: z.string().trim().min(2).max(80),
  unitPrice: z.number().min(0).max(1e12).default(0),
  isActive: z.boolean().default(true),
});

export const bookingGuestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  company: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  isVip: z.boolean().default(false),
});

const MAX_MS = BOOKING_MAX_HOURS * 3_600_000;

/** A booking as its organiser writes it; saved as a draft, sent for approval by the workflow. */
export const bookingDraftSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  kind: z.enum(BOOKING_KINDS).default('INTERNAL'),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  roomId: idSchema.nullish(),
  /** Where, when it is not a bookable room: another office, a client's, a café. */
  placeNote: z.string().trim().max(200).optional(),
  resourceIds: z.array(idSchema).max(10).default([]),
  parkingSpaces: z.number().int().min(0).max(50).default(0),
  participantIds: z.array(idSchema).max(100).default([]),
  guests: z.array(bookingGuestSchema).max(50).default([]),
  catering: z.array(z.object({ optionId: idSchema, quantity: z.number().int().min(1).max(500) })).max(20).default([]),
  approverId: idSchema.nullish(),
  projectId: idSchema.nullish(),
  companyId: idSchema.nullish(),
})
  .refine((b) => b.endsAt > b.startsAt, { message: 'پایان جلسه باید پس از آغاز آن باشد.', path: ['endsAt'] })
  .refine((b) => b.endsAt.getTime() - b.startsAt.getTime() <= MAX_MS, { message: 'جلسه بیش از ۱۲ ساعت نمی‌شود.', path: ['endsAt'] });
export type BookingDraft = z.infer<typeof bookingDraftSchema>;

/** A proposed time, checked before it is booked: who and what is already taken. */
export const availabilityQuerySchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  roomId: idSchema.optional(),
  resourceIds: z.array(idSchema).max(10).default([]),
  participantIds: z.array(idSchema).max(100).default([]),
  parkingSpaces: z.number().int().min(0).max(50).default(0),
  excludeBookingId: idSchema.optional(),
  /** For free rooms: at least this many seats, with these features. */
  seats: z.number().int().min(0).max(10_000).default(0),
  features: z.array(z.enum(RESOURCE_FEATURES)).default([]),
}).refine((b) => b.endsAt > b.startsAt, { message: 'پایان جلسه باید پس از آغاز آن باشد.', path: ['endsAt'] });

/** One reason a time does not work. */
export interface BookingConflict {
  kind: 'ROOM' | 'RESOURCE' | 'PERSON' | 'PARKING' | 'INACTIVE';
  /** The room, resource or person it concerns. */
  subjectId: string;
  nameFa: string;
  /** The booking in the way, when the asker may know of it; never its title otherwise. */
  bookingCode?: string;
  from?: string;
  to?: string;
  messageFa: string;
}
