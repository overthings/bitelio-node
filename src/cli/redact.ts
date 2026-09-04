/**
 * The filter every uploaded byte passes through.
 *
 * `init` reads a Stripe webhook handler and sends it to a model. A handler normally takes its
 * signing secret from `process.env` — *normally*. Plenty of git histories say otherwise, and the
 * cost of being wrong once is somebody's live key in a third party's logs, put there by a tool they
 * ran to save an afternoon.
 *
 * Two design choices carry this file:
 *
 * It redacts the VALUE and keeps the LINE. The model has to see that a secret is read here, and
 * where — dropping the line would hide the handler's shape along with the secret. For a recognisable
 * key the prefix survives too, because "there is a live Stripe key inlined here" is worth saying.
 *
 * And it is as careful about false positives as about misses. A lockfile hash and a long Tailwind
 * class list are both long opaque runs by shape; mangling them produces an extract the model cannot
 * read, a worse analysis, and no moment anyone can point at where it went wrong. Every rule below is
 * anchored on something a secret has and a hash does not.
 *
 * **This is a heuristic and it is not a guarantee.** It is a set of patterns, and a secret that
 * matches none of them goes through. Measured over 934 real source files it touches about 1% of
 * them, and it catches every credential shape in the tests below — but the thing that actually makes
 * the upload accountable is the consent screen, which shows the developer each file exactly as it
 * will be sent, already redacted, with the option to read it or drop it. This filter exists to make
 * that screen mostly boring. It does not exist to be trusted on its own.
 */

export interface Redacted {
  text: string;
  /**
   * How many values were replaced.
   *
   * Returned rather than kept private because the consent screen needs it: two redactions in a
   * webhook handler is a developer who inlined a secret, forty is a file that should not be
   * uploaded at all, and the screen can only say so if it is given the number.
   */
  count: number;
}

const PLACEHOLDER = '<redacted>';

/**
 * Values that are obviously not real, so redacting them would only make an example file useless.
 * `sk_live_xxxxxxxx` in a `.env.example` is documentation.
 *
 * Deliberately does NOT include the bare words `secret`, `key`, `value` or `here`. They read like
 * placeholders and they are also how a real value ends: `prod-secret-key` is a credential, and a
 * filter that spares it because the last word is `key` fails in the expensive direction. A password
 * that genuinely is the word "secret" gets redacted, which costs nothing.
 */
const OBVIOUS_PLACEHOLDER =
  /^(x+|y+|\.+|-+|_+|<[^>]*>|\{[^}]*\}|your[-_a-z0-9]*|my[-_a-z0-9]*|todo|changeme|change[-_]?me|placeholder|example|replace[-_a-z]*|not[-_]?real|fake|dummy|abc123|123456)$/i;

/** Lines whose long opaque runs are structurally not secrets. */
const NOT_A_SECRET_LINE = [
  // Lockfiles: an integrity hash is public by definition and long by shape.
  /\b(integrity|resolved|checksum)\b/i,
  /\bsha(1|256|384|512)-/,
  // Inline assets. Enormous, opaque, and not a credential.
  /\bdata:[a-z]+\/[a-z0-9.+-]+;base64,/i,
];

interface Rule {
  pattern: RegExp;
  /** Builds the replacement from the match, so a prefix worth keeping survives. */
  replace: (match: RegExpMatchArray) => string;
}

const RULES: Rule[] = [
  // Provider keys, prefix kept. Bitelio's own `sk_test_`/`sk_live_` share Stripe's shape, which is
  // convenient here: the tool must not leak the key it just minted either.
  {
    pattern: /\b((?:sk|pk|rk)_(?:live|test)_)[A-Za-z0-9]{8,}/g,
    replace: m => `${m[1]}${PLACEHOLDER}`,
  },
  {
    pattern: /\b(whsec_)[A-Za-z0-9+/=_-]{8,}/g,
    replace: m => `${m[1]}${PLACEHOLDER}`,
  },
  // Clerk, GitHub, Slack, OpenAI, Anthropic — anything shaped `prefix_longrun`.
  {
    pattern: /\b((?:sk|xox[baprs]|gh[pousr]|ghs|clerk|svix|SG)[_-])[A-Za-z0-9_-]{16,}/g,
    replace: m => `${m[1]}${PLACEHOLDER}`,
  },
  // A bearer token in a header.
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: m => `${m[1]}${PLACEHOLDER}`,
  },
  // The password inside a connection string. The scheme and host stay: knowing it is Postgres is
  // the useful part, and the password is the whole risk.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi,
    replace: m => `${m[1]}${PLACEHOLDER}${m[2]}`,
  },
];

/**
 * An assignment to something NAMED like a secret.
 *
 * The catch-all behind the shape rules above, and the only one that can catch a four-character
 * password. Two bounds keep it from eating ordinary code, both learned from running it over 900
 * real source files, where an earlier version touched 43% of them:
 *
 * `auth` is not on the list. As a substring it matches `authorization`, `authService`,
 * `authenticated` — and `const auth = res.locals.auth;` appears in every controller in that
 * codebase. What it would have caught is covered by the bearer-token and long-run rules anyway.
 *
 * And the VALUE must be a literal, not an expression. A secret that can leak is a string in the
 * source; `res.locals.auth`, `getToken()` and `req.headers.authorization` are references to
 * something that exists at runtime, and redacting them destroys the code without protecting
 * anything. Quoted values are always literals; unquoted ones (a `.env` line, which has no quotes)
 * are accepted only when they contain nothing that looks like code.
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:secret|password|passwd|api[_-]?key|apikey|private[_-]?key|credential|token)[A-Za-z0-9_]*`;

/**
 * `name: 'value'` or `NAME = "value"` — a quoted literal.
 *
 * The joiner refuses a second `=`, so `copiedToken === \`…\`` is read as the comparison it is
 * rather than as an assignment of the string `==`.
 */
const NAMED_SECRET_QUOTED = new RegExp(String.raw`\b(${SECRET_NAME})(\s*[:=](?!=)\s*)(['"\`])([^'"\`\n]+)\3`, 'gi');

/**
 * `NAME=value` with no quotes — a `.env` line, anchored to the start of one.
 *
 * Anchored, and to an UPPERCASE name, because that is what a `.env` line is and nothing else is.
 * Unanchored, this matched `tokens = await exchangeCodeForToken(shop, code)` and replaced the word
 * `await`: the "value" was a keyword, in the middle of a statement, in ordinary code.
 */
const NAMED_SECRET_BARE = new RegExp(String.raw`^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_?KEY|APIKEY|PRIVATE_?KEY|CREDENTIAL|TOKEN)[A-Z0-9_]*)(\s*=\s*)([^\s'"\`,;)}]+)\s*$`);

/** Anything that makes an unquoted value a piece of code rather than a credential. */
const LOOKS_LIKE_CODE = /[.()[\]{}<>$+*/\\|&!?]/;

/** A long opaque run with no name and no prefix to go on. Last resort, and the fussiest. */
const LONG_HEX = /\b[0-9a-f]{40,}\b/gi;
/**
 * A base64 run needs a digit in it.
 *
 * Without that, `PutEmailIdentityDkimSigningAttributesCommand` — an AWS SDK class name, 44 letters
 * — is a valid base64 run and gets replaced, in the middle of an import list. Random bytes encode
 * to something containing digits essentially always; a CamelCase identifier contains none.
 */
const HAS_DIGIT = /[0-9]/;
/**
 * `/` is in the base64 alphabet, which makes every long import path a candidate:
 * `'../services/ads/settings/AdsSettingsService.js'` is 40+ characters of it. A run containing a
 * slash therefore has to earn it — with `+` or `=` padding, which a path essentially never has.
 */
const LONG_BASE64 = /\b[A-Za-z0-9+]{40,}={0,2}\b|\b[A-Za-z0-9+/]{40,}(?:\+[A-Za-z0-9+/]*)?={1,2}\b/g;

/**
 * Names that describe a KIND of thing rather than name a credential.
 *
 * `TOKEN_URL`, `TOKEN_VERSION`, `subject_token_type` all contain "token" and none of them holds
 * one. Judged on the last segment, which is the part that says what the value is.
 */
const NAMES_A_KIND =
  /(?:_|(?<=[a-z]))(URL|URI|TYPE|VERSION|MODE|NAME|NAMES|ID|IDS|PREFIX|SUFFIX|HEADER|FIELD|PARAM|PATH|REGEX|PATTERN|LENGTH|TTL|EXPIRY|COUNT|LIMIT)$/i;

/**
 * Quoted values that are structurally not credentials.
 *
 * Each one was a real false positive over 630 source files: an enum whose value is its own name, a
 * URL, a dotted identifier like `order.last`, a `'scim_'` prefix about to be concatenated, and a
 * `__STORE_URL__` template marker.
 */
function isNotACredential(name: string, value: string): boolean {
  if (value === name) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^urn:/i.test(value)) return true;
  if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(value)) return true;
  if (/[_-]$/.test(value)) return true;
  if (/^__.*__$/.test(value)) return true;

  return false;
}

/** Inside a PEM block every line is the key. */
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

function isPlaceholder(value: string): boolean {
  if (OBVIOUS_PLACEHOLDER.test(value)) return true;

  // `sk_live_xxxxxxxx` in a .env.example is documentation, and redacting it makes the example
  // useless. Strip a leading `prefix_` chain and judge what is left.
  //
  // Safe to reuse the list on the remainder now that `key`, `secret`, `value` and `here` are off
  // it. That was the whole risk: with them on, `prod-secret-key` stripped to `key` and was spared.
  // What remains — `your…`, `changeme`, `xxxx` — is nobody's real credential.
  //
  // Every strip depth is tried, not just the greediest. Greedy alone ate `sk_YOUR_SECRET_` off
  // `sk_YOUR_SECRET_KEY` and judged the leftover `KEY`, which is not on the list, so the most
  // obvious placeholder in the codebase was redacted inside a documentation snippet.
  let rest = value;
  for (let depth = 0; depth < 3; depth++) {
    const stripped = rest.replace(/^[A-Za-z]{2,8}[_-]/, '');
    if (stripped === rest) break;
    if (OBVIOUS_PLACEHOLDER.test(stripped)) return true;
    rest = stripped;
  }

  return false;
}

/** `process.env.X` is what a well-written handler looks like — redacting it hides the good news. */
function isEnvReference(value: string): boolean {
  return /^(process\.env\.|import\.meta\.env\.|Deno\.env\b|\$\{?[A-Z_]+\}?$)/.test(value.trim());
}

export function redact(input: string): Redacted {
  let count = 0;
  let insidePem = false;

  const text = input
    .split('\n')
    .map(line => {
      if (PEM_BEGIN.test(line)) {
        insidePem = true;
        return line;
      }
      if (insidePem) {
        if (PEM_END.test(line)) {
          insidePem = false;
          return line;
        }
        // Every line between the markers is key material. The markers stay so the shape is legible.
        count += 1;
        return PLACEHOLDER;
      }

      let out = line;

      for (const rule of RULES) {
        out = out.replace(rule.pattern, (...args) => {
          const match = args.slice(0, -2) as unknown as RegExpMatchArray;
          const whole = match[0]!;
          // The tail after the kept prefix — what would actually be removed.
          const tail = whole.slice((match[1] ?? '').length);
          if (isPlaceholder(tail)) return whole;

          count += 1;
          return rule.replace(match);
        });
      }

      out = out.replace(NAMED_SECRET_QUOTED, (whole, name: string, joiner: string, quote: string, value: string) => {
        if (isEnvReference(value) || isPlaceholder(value)) return whole;
        if (NAMES_A_KIND.test(name) || isNotACredential(name, value)) return whole;
        // Already handled by a rule above; do not count it twice.
        if (value.includes(PLACEHOLDER)) return whole;

        count += 1;
        return `${name}${joiner}${quote}${PLACEHOLDER}${quote}`;
      });

      out = out.replace(NAMED_SECRET_BARE, (whole, name: string, joiner: string, value: string) => {
        if (isEnvReference(value) || isPlaceholder(value) || LOOKS_LIKE_CODE.test(value)) return whole;
        if (NAMES_A_KIND.test(name.trim()) || isNotACredential(name.trim(), value)) return whole;
        if (value.includes(PLACEHOLDER)) return whole;

        count += 1;
        return `${name}${joiner}${PLACEHOLDER}`;
      });

      // The nameless long runs, only on lines that are not structurally hashes or inline assets.
      if (!NOT_A_SECRET_LINE.some(pattern => pattern.test(line))) {
        for (const pattern of [LONG_HEX, LONG_BASE64]) {
          out = out.replace(pattern, run => {
            if (run.includes(PLACEHOLDER)) return run;
            if (pattern === LONG_BASE64 && !HAS_DIGIT.test(run)) return run;
            count += 1;
            return PLACEHOLDER;
          });
        }
      }

      return out;
    })
    .join('\n');

  return {text, count};
}
