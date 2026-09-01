import type {HttpClient} from '../client.js';
import {BitelioError} from '../errors.js';
import type {TrackParams} from '../types.js';

export interface TrackResult {
  contact: string;
  event: string;
  timestamp: string;
}

export class Events {
  constructor(private readonly http: HttpClient) {}

  /**
   * Records an event against a contact, creating them if they are new. This is what triggers a
   * workflow, so it is the call a SaaS makes from its own lifecycle code.
   *
   * Values in `data` are saved onto the contact and are available to every later message. To pass
   * something for this event only, wrap it: `{orderId: {value: '123', persistent: false}}`.
   *
   * Authenticates with your PUBLIC key, which is why the client has to be given one. This endpoint
   * is the same one browsers post to, and today it has no secret-key equivalent that identifies a
   * contact by email address — `POST /events/track` does exist for secret keys, but it requires a
   * contact id you would have to go and look up first. Supplying the public key is not a
   * concession: it ships in every page of your own site already.
   */
  async track(params: TrackParams): Promise<TrackResult> {
    if (this.http.publicKey === undefined) {
      throw new BitelioError(
        'events.track needs your project\'s public key: new Bitelio(secretKey, {publicKey: "pk_…"}). ' +
          'Find it in Settings → General. It is not a secret — it already ships in your website\'s HTML.',
        {status: 0},
      );
    }

    const response = await this.http.request<{success: boolean; data: TrackResult}>('POST', '/v1/track', {
      body: params,
      authToken: this.http.publicKey,
    });

    return response.data;
  }
}
