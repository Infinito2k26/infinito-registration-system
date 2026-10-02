import { Flash } from '../web/cookies';
import { fmtDate, fmtExact } from '../web/layout';
import { CheckInOutcome, CheckOutOutcome, GateSubject } from './entry.service';

type EventName = (slug: string) => string;

/** "Priya Sharma · NIT Patna · Table Tennis" — what the gate needs, nothing private. */
const subject = (who: GateSubject, eventName: EventName) =>
  [who.name, who.college, eventName(who.eventSlug)].filter(Boolean).join(' · ');

export const BLOCKED_TEXT = 'ACCESS BLOCKED: registration access has been blocked. Please contact the coordinator/admin.';

/** Gate feedback shared by the pass page and the participant page. */
export function checkInFlash(outcome: CheckInOutcome, eventName: EventName): Flash {
  switch (outcome.result) {
    case 'entered':
      return { type: 'ok', text: `✅ ENTERED (CHECK IN): ${subject(outcome.who, eventName)} · ${fmtExact(outcome.at)}. Now INSIDE.` };
    case 'already-inside': {
      const by = [outcome.byName && `checked in by ${outcome.byName}`, outcome.gate].filter(Boolean).join(', ');
      return {
        type: 'error',
        text: `ALREADY ENTERED: inside since ${fmtDate(outcome.since)}${by ? ` (${by})` : ''}. Do not admit again; check out first.`,
      };
    }
    case 'blocked':
      return { type: 'error', text: BLOCKED_TEXT };
    case 'not-verified':
      return { type: 'error', text: 'NOT VERIFIED. Do not admit.' };
    default:
      return { type: 'error', text: 'INVALID QR: registration not found for this pass' };
  }
}

export function checkOutFlash(outcome: CheckOutOutcome, eventName: EventName): Flash {
  switch (outcome.result) {
    case 'checked-out':
      return {
        type: 'ok',
        text: `⬅ CHECKED OUT: ${subject(outcome.who, eventName)} · ${fmtExact(outcome.at)}. Now OUTSIDE.${outcome.override ? ' (admin override)' : ''}`,
      };
    case 'not-inside':
      return {
        type: 'error',
        text: outcome.neverEntered
          ? 'Cannot check out: this participant has never checked in.'
          : `Cannot check out: not inside${outcome.lastCheckOutAt ? ` (checked out at ${fmtDate(outcome.lastCheckOutAt)})` : ''}.`,
      };
    case 'blocked':
      return { type: 'error', text: BLOCKED_TEXT };
    default:
      return { type: 'error', text: 'INVALID QR: registration not found for this pass' };
  }
}
