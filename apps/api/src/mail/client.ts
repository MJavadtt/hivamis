import { mailEnabled } from '../env.js';
import { enqueueMail, type MailJob } from '../jobs/runner.js';

/**
 * Mail to people outside the organisation — approval links and codes (#35), portal invitations
 * (#34). One switch, so a test swaps it the way the tax tests swap MOADIAN_MODE.
 */
export const clientMail = {
  deliver: (job: MailJob) => enqueueMail(job),
  enabled: () => mailEnabled,
};
