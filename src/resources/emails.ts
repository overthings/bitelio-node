import {HttpClient} from '../client.js';
import type {Email, EmailDetail, EmailListParams, Page, SendParams, SendResult} from '../types.js';

function isoOrUndefined(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

export class Emails {
  constructor(private readonly http: HttpClient) {}

  /**
   * Sends one transactional email, or one per recipient when `to` is an array.
   *
   * An idempotency key is generated for you unless you supply one. That is not a nicety: this
   * client retries 429s and 5xx responses, and a retried send without a key is a duplicate in
   * somebody's inbox.
   */
  async send(params: SendParams): Promise<SendResult> {
    const {idempotencyKey, ...body} = params;

    const response = await this.http.request<{success: boolean; data: SendResult}>('POST', '/v1/send', {
      body,
      idempotencyKey: idempotencyKey ?? HttpClient.newIdempotencyKey(),
    });

    return response.data;
  }

  /**
   * One page of your send history, newest first.
   *
   * Shows live sends only unless you pass `mode`. Page by handing `nextCursor` straight back —
   * it is opaque, and `null` means you have reached the end.
   */
  async list(params: EmailListParams = {}): Promise<Page<Email>> {
    return this.http.request<Page<Email>>('GET', '/v1/emails', {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        mode: params.mode,
        status: params.status,
        to: params.to,
        since: isoOrUndefined(params.since),
        until: isoOrUndefined(params.until),
      },
    });
  }

  /**
   * One email, including the HTML that actually went out — after variables were substituted,
   * blocks resolved and your brand applied. Most "the email looks wrong" reports end here.
   */
  async get(id: string): Promise<EmailDetail> {
    const response = await this.http.request<{data: EmailDetail}>('GET', `/v1/emails/${encodeURIComponent(id)}`);

    return response.data;
  }

  /**
   * Every send matching the filter, one page at a time.
   *
   * An async iterator rather than an array: a project's history does not fit in memory, and the
   * shape of this method is what stops somebody discovering that in production.
   */
  async *iterate(params: Omit<EmailListParams, 'cursor'> = {}): AsyncGenerator<Email> {
    let cursor: string | undefined;
    do {
      const page = await this.list({...params, cursor});
      for (const email of page.data) yield email;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }
}
