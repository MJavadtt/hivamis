import { z } from 'zod';

/**
 * A person's profile (audit F-6): a photo and a few words, theirs to write, shown to colleagues
 * wherever they appear. The photo itself is sent as a file and re-encoded by the server.
 */

export const PROFILE_LIMITS = { bio: 500, pronouncedName: 120, skills: 20, skill: 40, links: 5, link: 200 } as const;
/** What a photo may arrive as; whatever it was, it is kept as a 512px WebP. */
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const AVATAR_MAX_MB = 10;
export const AVATAR_SIZE = 512;

const blankToNull = (v: unknown) => (typeof v === 'string' && !v.trim() ? null : v);

export const updateProfileSchema = z.object({
  bio: z.preprocess(blankToNull, z.string().trim().max(PROFILE_LIMITS.bio, 'حداکثر ۵۰۰ حرف').nullable()).optional(),
  pronouncedName: z.preprocess(blankToNull, z.string().trim().max(PROFILE_LIMITS.pronouncedName).nullable()).optional(),
  skills: z.array(z.string().trim().min(1).max(PROFILE_LIMITS.skill)).max(PROFILE_LIMITS.skills, 'حداکثر بیست مهارت')
    .transform((xs) => [...new Set(xs)]).optional(),
  // Only https: a link on someone's page is followed by colleagues trusting it.
  links: z.array(z.string().trim().max(PROFILE_LIMITS.link).url('نشانی کامل بنویسید').refine((u) => u.startsWith('https://'), 'فقط نشانی‌های https'))
    .max(PROFILE_LIMITS.links, 'حداکثر پنج پیوند').optional(),
});
export type UpdateProfile = z.infer<typeof updateProfileSchema>;
