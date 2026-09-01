import type {HttpClient} from '../client.js';
import type {Contact} from '../types.js';

export interface CreateContactParams {
  email: string;
  subscribed?: boolean;
  data?: Record<string, unknown>;
}

export interface UpdateContactParams {
  email?: string;
  subscribed?: boolean;
  data?: Record<string, unknown>;
}

export class Contacts {
  constructor(private readonly http: HttpClient) {}

  async create(params: CreateContactParams): Promise<Contact> {
    return this.http.request<Contact>('POST', '/contacts', {body: params});
  }

  async get(id: string): Promise<Contact> {
    return this.http.request<Contact>('GET', `/contacts/${encodeURIComponent(id)}`);
  }

  async update(id: string, params: UpdateContactParams): Promise<Contact> {
    return this.http.request<Contact>('PATCH', `/contacts/${encodeURIComponent(id)}`, {body: params});
  }

  /** Irreversible, and it takes the contact's send history with it. */
  async delete(id: string): Promise<void> {
    await this.http.request<void>('DELETE', `/contacts/${encodeURIComponent(id)}`);
  }
}
