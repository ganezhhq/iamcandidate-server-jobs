import { z } from "zod"

import {
  isoDate,
  longText,
  patchSchema,
  requiredText,
  shortText,
  stringList,
  urlText,
} from "../lib/validation"
import {
  APPLICATION_STATUSES,
  COMPANY_STATUSES,
  INTERVIEW_STATUSES,
  INTERVIEW_TYPES,
  PRIORITIES,
  REFERRAL_STATUSES,
  RELATIONSHIPS,
  TIMELINE_EVENT_TYPES,
  WORK_MODES,
} from "../models"

const entityId = z.string().trim().min(1).max(128)

/* Applications ------------------------------------------------------ */

export const applicationInput = z.strictObject({
  companyId: entityId,
  role: requiredText(),
  location: shortText(),
  workMode: z.enum(WORK_MODES),
  salary: shortText().optional(),
  status: z.enum(APPLICATION_STATUSES),
  priority: z.enum(PRIORITIES),
  appliedDate: isoDate.optional(),
  nextFollowUp: isoDate.optional(),
  jobUrl: urlText.optional(),
  jobId: shortText().optional(),
  source: shortText().optional(),
  description: longText().optional(),
  recruiterId: entityId.optional(),
  resumeId: entityId.optional(),
  notes: longText(),
})
export type ApplicationInput = z.output<typeof applicationInput>
export const applicationPatch = patchSchema(applicationInput)

/** A job or profile link to read for the "add from link" chat. */
export const jobLinkBody = z.strictObject({ url: urlText })

const JOB_BOARD = "(greenhouse|lever|ashby):[a-zA-Z0-9][\\w.-]{0,99}"

/** `type:slug` pairs, e.g. `greenhouse:acme,lever:globex`. */
const jobBoards = z
  .string()
  .regex(new RegExp(`^${JOB_BOARD}(,${JOB_BOARD})*$`))
  .transform((value) =>
    value.split(",").map((pair) => {
      const [type, slug] = pair.split(":") as ["greenhouse" | "lever" | "ashby", string]
      return { type, slug }
    }),
  )
  .refine((boards) => boards.length <= 10, "Search at most 10 job boards at once")

export const jobSearchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  location: z.string().trim().max(120).default(""),
  remote: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  page: z.coerce.number().int().min(1).max(20).default(1),
  boards: jobBoards.optional().transform((boards) => boards ?? []),
})

export const applicationStatusBody = z.strictObject({ status: z.enum(APPLICATION_STATUSES) })

export const timelineEventInput = z.strictObject({
  date: isoDate,
  title: requiredText(),
  description: shortText(2000).optional(),
  type: z.enum(TIMELINE_EVENT_TYPES),
})

export const applicationQuery = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  companyId: entityId.optional(),
})

/* Companies --------------------------------------------------------- */

export const companyInput = z.strictObject({
  name: requiredText(),
  industry: shortText(),
  website: urlText,
  location: shortText(),
  size: shortText(),
  status: z.enum(COMPANY_STATUSES),
  description: longText(),
  notes: longText(),
})
export type CompanyInput = z.output<typeof companyInput>
export const companyPatch = patchSchema(companyInput)

export const companyQuery = z.object({ status: z.enum(COMPANY_STATUSES).optional() })

/* Contacts ---------------------------------------------------------- */

export const contactInput = z.strictObject({
  name: requiredText(),
  role: shortText(),
  companyId: entityId.optional(),
  email: z.union([z.literal(""), z.email()]),
  phone: shortText(50).optional(),
  linkedin: urlText.optional(),
  relationship: z.enum(RELATIONSHIPS),
  lastContacted: isoDate.optional(),
  nextFollowUp: isoDate.optional(),
  notes: longText(),
})
export type ContactInput = z.output<typeof contactInput>
export const contactPatch = patchSchema(contactInput)

export const contactQuery = z.object({
  companyId: entityId.optional(),
  relationship: z.enum(RELATIONSHIPS).optional(),
})

/* Referrals --------------------------------------------------------- */

export const referralInput = z.strictObject({
  contactId: entityId,
  companyId: entityId,
  role: requiredText(),
  jobId: shortText(),
  jobUrl: urlText,
  requestDate: isoDate.optional(),
  followUpDate: isoDate.optional(),
  status: z.enum(REFERRAL_STATUSES),
  notes: longText(),
})
export type ReferralInput = z.output<typeof referralInput>
export const referralPatch = patchSchema(referralInput)

export const referralQuery = z.object({
  companyId: entityId.optional(),
  contactId: entityId.optional(),
  status: z.enum(REFERRAL_STATUSES).optional(),
})

/* Interviews -------------------------------------------------------- */

export const interviewInput = z.strictObject({
  applicationId: entityId,
  type: z.enum(INTERVIEW_TYPES),
  scheduledAt: isoDate,
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  interviewers: stringList(20, 200),
  meetingUrl: urlText.optional(),
  status: z.enum(INTERVIEW_STATUSES),
  notes: longText(),
})
export type InterviewInput = z.output<typeof interviewInput>
export const interviewPatch = patchSchema(interviewInput)

export const interviewQuery = z.object({
  applicationId: entityId.optional(),
  status: z.enum(INTERVIEW_STATUSES).optional(),
})
