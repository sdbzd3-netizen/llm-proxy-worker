// API proxy endpoint mappings
// Usage: https://your-worker.workers.dev/{provider}/{original-api-path}
const API_ENDPOINTS = {
  // AI / LLM
  'openai': 'https://api.openai.com',
  'anthropic': 'https://api.anthropic.com',
  'gemini': 'https://generativelanguage.googleapis.com',
'gemini-oai': 'https://generativelanguage.googleapis.com/v1beta/openai',
  'groq': 'https://api.groq.com',
  'sambanova': 'https://api.sambanova.ai',
  'azure': 'https://YOUR_AZURE_RESOURCE_NAME.openai.azure.com',

  // GitHub
  'github': 'https://api.github.com',
  'raw': 'https://raw.githubusercontent.com',
  'gh-models': 'https://models.inference.ai.azure.com',

  // HuggingFace
  'hf': 'https://huggingface.co',
  'hfi': 'https://api-inference.huggingface.co',

  // Add more endpoints as needed
};

// Rate limiting: token bucket per IP
const RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 100,
};

const requestCounts = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT.windowMs) {
    requestCounts.set(ip, { windowStart: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT.maxRequests - 1 };
  }
  if (record.count >= RATE_LIMIT.maxRequests) {
    return { allowed: false, remaining: 0 };
  }
  record.count++;
  return { allowed: true, remaining: RATE_LIMIT.maxRequests - record.count };
}


// API Keys - stored as secrets via wrangler
// GITHUB_TOKEN, GEMINI_API_KEY, HF_TOKEN set via `wrangler secret put`
const API_KEYS = {
  'github': typeof GITHUB_TOKEN !== 'undefined' ? GITHUB_TOKEN : null,
  'gemini': typeof GEMINI_API_KEY !== 'undefined' ? GEMINI_API_KEY : null,
  'gemini-oai': typeof GEMINI_API_KEY !== 'undefined' ? GEMINI_API_KEY : null,
  'gh-models': typeof GITHUB_TOKEN !== 'undefined' ? GITHUB_TOKEN : null,
  'hf': typeof HF_TOKEN !== 'undefined' ? HF_TOKEN : null,
  'hfi': typeof HF_TOKEN !== 'undefined' ? HF_TOKEN : null,
  'groq': typeof GROQ_API_KEY !== 'undefined' ? GROQ_API_KEY : null,
};

// Worker access password - set via wrangler secret put
const WORKER_PASSWORD = typeof WORKER_SECRET !== 'undefined' ? WORKER_SECRET : null;

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  console.log(`Incoming: ${request.method} ${request.url}`);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return handleCORS(request);
  }

  // ---- Auth check ----
  const clientPassword = request.headers.get('X-API-Key');
  if (WORKER_PASSWORD && clientPassword !== WORKER_PASSWORD) {
    return new Response('Unauthorized: invalid or missing X-API-Key', { status: 403 });
  }

  // Rate limiting
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { allowed, remaining } = rateLimit(ip);
  if (!allowed) {
    return new Response('Rate limit exceeded', { status: 429 });
  }

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(part => part);

  // Health check
  if (pathParts.length === 0 || pathParts[0] === 'health') {
    return new Response(JSON.stringify({
      status: 'ok',
      endpoints: Object.keys(API_ENDPOINTS),
      usage: `${url.origin}/{provider}/{path}`
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  }

  const provider = pathParts[0];
  const targetBase = API_ENDPOINTS[provider];
  if (!targetBase) {
    return new Response(
      `Unknown provider "${provider}". Available: ${Object.keys(API_ENDPOINTS).join(', ')}`,
      { status: 400 }
    );
  }

  // Build target URL
  const newPathname = '/' + pathParts.slice(1).join('/');
  const targetUrl = new URL(targetBase);
  targetUrl.pathname = newPathname;
  targetUrl.search = url.search;

  console.log(`Proxying to ${provider}: ${targetUrl}`);

  // Clean headers
  const cleanedHeaders = new Headers();
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase();
    if (!lower.startsWith('cf-') &&
        !['x-real-ip', 'x-forwarded-for', 'x-forwarded-proto',
          'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-scheme',
          'x-forwarded-ssl', 'cdn-loop'].includes(lower)) {
      // Skip user-provided auth headers for providers we have secrets for
      if ((lower === 'authorization' || lower === 'x-goog-api-key') && API_KEYS[provider]) continue;
      cleanedHeaders.set(key, value);
    }
  }

  // Inject API key if we have one for this provider
  if (API_KEYS[provider]) {
    if (provider === 'gemini') {
      // Native Gemini API: key goes in query param
      targetUrl.searchParams.set('key', API_KEYS[provider]);
    } else if (provider === 'gemini-oai') {
      // OpenAI-compatible Gemini: key goes in Bearer header
      cleanedHeaders.set('Authorization', `Bearer ${API_KEYS[provider]}`);
    } else {
      cleanedHeaders.set('Authorization', `Bearer ${API_KEYS[provider]}`);
    }
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: cleanedHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      redirect: 'follow'
    });

    console.log(`Response from ${provider}: ${response.status}`);

    const modifiedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });

    modifiedResponse.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
    modifiedResponse.headers.set('Access-Control-Allow-Credentials', 'true');
    modifiedResponse.headers.set('X-Proxy-Provider', provider);
    modifiedResponse.headers.set('X-RateLimit-Remaining', String(remaining));

    return modifiedResponse;
  } catch (error) {
    console.error(`Error proxying to ${provider}:`, error);
    return new Response(`Proxy error for ${provider}: ${error.message}`, { status: 502 });
  }
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function handleCORS(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request)
  });
}
