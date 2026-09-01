import type {BitelioOptions} from './client.js';
import {HttpClient} from './client.js';
import {Contacts} from './resources/contacts.js';
import {Emails} from './resources/emails.js';
import {Events} from './resources/events.js';
import * as webhooks from './webhooks.js';

export {BitelioError} from './errors.js';
export type {BitelioOptions} from './client.js';
export type {CreateContactParams, UpdateContactParams} from './resources/contacts.js';
export type {TrackResult} from './resources/events.js';
export type {VerifyParams} from './webhooks.js';
export type * from './types.js';

/**
 * The Bitelio client.
 *
 * ```ts
 * import {Bitelio} from 'bitelio';
 *
 * const bitelio = new Bitelio(process.env.BITELIO_API_KEY!);
 *
 * await bitelio.emails.send({
 *   from: 'onboarding@send.bitelio.com',
 *   to: 'you@yourcompany.com',
 *   subject: 'Hello',
 *   body: '<p>It works.</p>',
 * });
 * ```
 *
 * Covers sending, reading your send history, contacts and events — what you drive from code.
 * Campaigns, segments, templates and workflows are designed in the dashboard and are deliberately
 * not here.
 */
export class Bitelio {
  readonly emails: Emails;
  readonly contacts: Contacts;
  readonly events: Events;

  /** Verifying a webhook we sent you. Also exported standalone, for receivers with no client. */
  static readonly webhooks = webhooks;

  constructor(apiKey: string, options: BitelioOptions = {}) {
    const http = new HttpClient(apiKey, options);
    this.emails = new Emails(http);
    this.contacts = new Contacts(http);
    this.events = new Events(http);
  }
}

export {webhooks};
export default Bitelio;
