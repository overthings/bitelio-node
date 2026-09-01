/** Whether a send actually went out. A test key records everything and delivers nothing. */
export type EmailMode = 'live' | 'test';

export type EmailStatus =
  | 'PENDING'
  | 'SENDING'
  | 'HELD'
  | 'SENT'
  | 'DELIVERED'
  | 'RECEIVED'
  | 'OPENED'
  | 'CLICKED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'FAILED';

/** A send, as it appears in a listing. The rendered body is on `emails.get` only. */
export interface Email {
  id: string;
  to: string;
  subject: string;
  from: string;
  fromName: string | null;
  status: EmailStatus;
  testMode: boolean;
  /** The provider's id. Prefixed `test-` for a send that never left. */
  messageId: string | null;
  error: string | null;
  opens: number;
  clicks: number;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
}

/** One send, with the HTML that actually went out. */
export interface EmailDetail extends Email {
  body: string;
  replyTo: string | null;
  toName: string | null;
  headers: Record<string, string> | null;
  sourceType: string;
}

export interface EmailListParams {
  limit?: number;
  /** The previous page's `nextCursor`, verbatim. Opaque. */
  cursor?: string;
  /** `live` unless you say otherwise — a test send is noise a day later. */
  mode?: 'live' | 'test' | 'all';
  status?: EmailStatus;
  /** Recipient address. Empty page if they are not a contact of your project. */
  to?: string;
  since?: Date | string;
  until?: Date | string;
}

export interface Page<T> {
  data: T[];
  /** `null` on the last page. */
  nextCursor: string | null;
}

export type Recipient = string | {name?: string; email: string};

export interface SendParams {
  to: Recipient | Recipient[];
  subject?: string;
  body?: string;
  /** A template id, instead of `subject` + `body`. */
  template?: string;
  from?: string | {name?: string; email: string};
  name?: string;
  reply?: string;
  headers?: Record<string, string>;
  data?: Record<string, unknown>;
  subscribed?: boolean;
  attachments?: {filename: string; content: string; contentType: string}[];
  /**
   * Overrides the key generated for you. Supply your own when the natural unit of work is not one
   * call — the same order confirmation retried across two processes, say.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  emails: {contact: {id: string; email: string}; email: string}[];
  timestamp: string;
}

export interface Contact {
  id: string;
  email: string;
  subscribed: boolean;
  data: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackParams {
  event: string;
  email: string;
  data?: Record<string, unknown>;
  subscribed?: boolean;
}
