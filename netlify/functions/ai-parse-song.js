function extractFirstJsonObject(text) {
  if (!text) return null;
  const s = String(text);
  const unfenced = s.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function clipText(s, maxLen) {
  const t = typeof s === 'string' ? s : '';
  if (!t) return '';
  const trimmed = t.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen);
}

function parseAiResponseText(respText) {
  let json = null;
  try {
    json = JSON.parse(respText);
  } catch {
    json = null;
  }

  const content =
    json?.choices?.[0]?.message?.content ||
    json?.choices?.[0]?.text ||
    '';

  const parsed = extractFirstJsonObject(content) || extractFirstJsonObject(respText);
  const trackName = typeof parsed?.trackName === 'string' ? parsed.trackName.trim() : '';
  const artistName = typeof parsed?.artistName === 'string' ? parsed.artistName.trim() : '';

  return {
    trackName,
    artistName,
    raw: String(content || respText || '').slice(0, 1200),
  };
}

function buildPayload({ model, title, author, maxTokens = null }) {
  const system =
    'Output ONLY minified JSON with exactly these keys: {"trackName":"","artistName":""}. ' +
    'artistName MUST be the empty string. No other text.';

  const user =
    'Extract trackName for lyrics search. ' +
    'Rules: remove bracketed info (e.g. () [] 【】), remove words like Official/Lyrics/MV/Live/HD/4K. ' +
    'If title has Chinese+English, return ONLY the Chinese title (no English subtitle). ' +
    `title="${title}" author="${author}"`;

  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    reasoning: { effort: 'low' },
    temperature: 0,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    // If supported by provider.
    response_format: { type: 'json_object' },
  };

  // User preference: do not limit tokens unless explicitly configured.
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
    payload.max_completion_tokens = maxTokens;
  }

  return payload;
}

async function callApiplus({ apiKey, payload }) {
  const res = await fetch('https://api.apiplus.org/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'user-agent': 'karaoke-app/1.0 (netlify)',
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

function getUnknownParamName(text) {
  try {
    const j = JSON.parse(text);
    const param = j?.error?.param;
    return typeof param === 'string' ? param : '';
  } catch {
    return '';
  }
}

function stripParam(payload, paramName) {
  if (!paramName || typeof payload !== 'object' || payload === null) return payload;
  const clone = { ...payload };
  if (Object.prototype.hasOwnProperty.call(clone, paramName)) {
    delete clone[paramName];
  }
  return clone;
}

exports.handler = async (event) => {
  try {
    const apiKey = process.env.APIPLUS_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Missing APIPLUS_API_KEY on Netlify' }),
      };
    }

    let body = {};
    try {
      body = event?.body ? JSON.parse(event.body) : {};
    } catch {
      body = {};
    }

    const title = clipText(body?.title, 200);
    const author = clipText(body?.author, 120);
    if (!title && !author) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Missing title/author' }),
      };
    }

    const model = process.env.APIPLUS_MODEL || 'gpt-5-nano-2025-08-07';
    const maxTokensRaw = process.env.APIPLUS_MAX_TOKENS;
    const maxTokensParsed = maxTokensRaw ? parseInt(String(maxTokensRaw), 10) : NaN;
    const maxTokens = Number.isFinite(maxTokensParsed) && maxTokensParsed > 0 ? maxTokensParsed : null;

    let payload = buildPayload({ model, title, author, maxTokens });

    // At most 1 retry on unknown_parameter.
    let out = await callApiplus({ apiKey, payload });
    if (out.status === 400) {
      const unknown = getUnknownParamName(out.text);
      if (unknown) {
        payload = stripParam(payload, unknown);
        out = await callApiplus({ apiKey, payload });
      }
    }

    if (out.status === 429) {
      return {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'AI rate limited (429)', detail: String(out.text || '').slice(0, 800) }),
      };
    }

    if (out.status < 200 || out.status >= 300) {
      return {
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: `AI service error (${out.status})`, detail: String(out.text || '').slice(0, 800) }),
      };
    }

    const parsed = parseAiResponseText(out.text);
    if (!parsed.trackName && !parsed.artistName) {
      return {
        statusCode: 422,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'AI returned empty output', model, raw: parsed.raw }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackName: parsed.trackName, artistName: parsed.artistName, model, raw: parsed.raw }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'AI service unavailable' }),
    };
  }
};
