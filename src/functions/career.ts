import { createHandler } from "../lib/router"
import {
  applicationRoutes,
  companyRoutes,
  contactRoutes,
  interviewRoutes,
  jobRoutes,
  referralRoutes,
} from "../handlers/career"

/** CareerFunction: applications, job search, companies, contacts, referrals, interviews. */
export const handler = createHandler({
  ...applicationRoutes,
  ...jobRoutes,
  ...companyRoutes,
  ...contactRoutes,
  ...referralRoutes,
  ...interviewRoutes,
})
