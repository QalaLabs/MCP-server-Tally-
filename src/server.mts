import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import crypto from 'node:crypto';
import dotenv from 'dotenv'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { registerMcpServer } from './mcp.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(packageRoot, '.env'), override: true, quiet: true });

const mcpPort = parseInt(process.env.PORT || '3000');
const mcpDomain = process.env.MCP_DOMAIN || 'http://localhost:3000';
const __dirname = import.meta.dirname;

// Host header is hostname[:port], never a full URL — SDK allowedHosts must match that
const mcpAllowedHosts: string[] = (() => {
  const hosts = new Set<string>(['localhost', '127.0.0.1']);
  try {
    hosts.add(new URL(mcpDomain).host);
  } catch {
    hosts.add(mcpDomain);
  }
  // Optional comma-separated extra hosts (Cloud Run *.a.run.app alias, custom domains)
  for (const h of (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    hosts.add(h);
  }
  return [...hosts];
})();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authPassword = process.env.PASSWORD || 'password';

// HMAC key for stateless token signing — no shared memory required across instances
const tokenSecret = process.env.TOKEN_SECRET || (authPassword + ':tally-mcp-token-secret');

// Encode a payload as a self-verifying signed token
const signPayload = (payload: object): string => {
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret).update(payloadStr).digest('base64url');
  return `${payloadStr}.${sig}`;
};

// Verify and decode a signed token; returns null if invalid or expired
const verifyPayload = <T extends { expires_at: number }>(token: string): T | null => {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const payloadStr = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto.createHmac('sha256', tokenSecret).update(payloadStr).digest('base64url');
  try {
    const expectedBuf = Buffer.from(expectedSig);
    const actualBuf = Buffer.from(sig);
    if (expectedBuf.length !== actualBuf.length) return null;
    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
    const data = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as T;
    if (data.expires_at < Date.now()) return null;
    return data;
  } catch { return null; }
};

// Helper function to verify PKCE
const verifyPKCE = (verifier: string, challenge: string, method: string): boolean => {
  if (method !== 'S256') return false;
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return hash === challenge;
};

// MCP session transports (per-instance; session affinity held by the SSE long-poll connection)
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle POST requests for client-to-server communication
const handleMcpRequest = async (req: express.Request, res: express.Response) => {
  const handleUnauthorized = () => {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: No valid authentication token provided' },
      id: null,
    });
  };

  const authHeader = req.headers['authorization'] as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    handleUnauthorized();
    return;
  }

  const token = authHeader.split(' ')[1];
  const tokenData = verifyPayload<{ client_id: string; expires_at: number }>(token);
  if (!tokenData) {
    handleUnauthorized();
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports[sessionId] = transport;
      },
      // Host header values only (e.g. example.run.app), not https://...
      allowedHosts: mcpAllowedHosts,
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };

    const mcpServer = await registerMcpServer();
    await mcpServer.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
};

// Claude posts MCP to connector base URL (/). Also keep /mcp for clients that use resource metadata.
app.post('/', handleMcpRequest);
app.post('/mcp', handleMcpRequest);

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);
app.delete('/', handleSessionRequest);

const handleOAuthProtectedResource = (req: express.Request, res: express.Response) => {
  res.status(200).json({
    // Claude connector posts MCP JSON-RPC to the base URL (/)
    resource: `${mcpDomain}`,
    authorization_servers: [`${mcpDomain}`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['email']
  });
};

app.get('/.well-known/oauth-protected-resource', handleOAuthProtectedResource);
app.get('/.well-known/oauth-protected-resource/mcp', handleOAuthProtectedResource);

const handleOAuthAuthorizationServer = (req: express.Request, res: express.Response) => {
  res.status(200).json({
    issuer: mcpDomain,
    authorization_endpoint: `${mcpDomain}/authorize`,
    token_endpoint: `${mcpDomain}/token`,
    registration_endpoint: `${mcpDomain}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256']
  });
};

app.get('/.well-known/oauth-authorization-server', handleOAuthAuthorizationServer);

app.post('/register', (req, res) => {
  // Dynamic registration — just return plausible credentials; state not needed
  const clientId = crypto.randomBytes(16).toString('base64url');
  const clientSecret = crypto.randomBytes(32).toString('base64url');
  const clientName = req.body['client_name'] || 'Unnamed Client';
  const redirectUris = req.body['redirect_uris'] || [];

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return res.status(400).json({ error: 'redirect_uris must be a non-empty array' });
  }

  res.status(200).json({
    client_id: clientId,
    client_name: clientName,
    client_secret: clientSecret,
    redirect_uris: redirectUris
  });
});

app.post('/authorize', (req, res) => {
  const clientId = req.body['client_id'];
  const redirectUri = req.body['redirect_uri'];
  const codeChallenge = req.body['code_challenge'];
  const codeChallengeMethod = req.body['code_challenge_method'];
  const state = req.body['state'];
  const password = req.body['password'];

  if (!clientId || !password) {
    return res.status(400).json({ error: 'Missing client_id or password' });
  }

  if (password !== authPassword) {
    return res.status(200).json({ status: false });
  }

  // Stateless auth code: HMAC-signed payload, self-verifiable on any instance
  const code = signPayload({
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    expires_at: Date.now() + 600000 // 10 minutes
  });

  // Build the callback URL server-side so state is never lost in client JS
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set('code', code);
  if (state) callbackUrl.searchParams.set('state', state);

  res.status(200).json({ status: true, code, redirect_url: callbackUrl.toString() });
});

app.get('/authorize', async (req, res) => {
  const clientId = req.query.client_id as string;
  const redirectUri = req.query.redirect_uri as string;
  const codeChallenge = req.query.code_challenge as string;
  const codeChallengeMethod = req.query.code_challenge_method as string;
  const responseType = req.query.response_type as string;

  if (!clientId || !redirectUri || !codeChallenge || !responseType) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters'
    });
  }

  if (responseType !== 'code') {
    return res.status(400).json({
      error: 'unsupported_response_type',
      error_description: 'Only "code" response type is supported'
    });
  }

  if (codeChallengeMethod !== 'S256') {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Only S256 code challenge method is supported'
    });
  }

  res.status(200).header('Content-Type', 'text/html').sendFile(path.join(__dirname, '../authorize.html'));
});

app.post('/token', (req, res) => {
  const grantType = req.body['grant_type'];
  const code = req.body['code'];
  const redirectUri = req.body['redirect_uri'];
  let clientId = req.body['client_id'];
  const codeVerifier = req.body['code_verifier'];

  if (!clientId) {
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Basic ')) {
      const base64Credentials = authHeader.split(' ')[1];
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const [authClientId] = credentials.split(':');
      clientId = authClientId;
    }
  }

  if (grantType !== 'authorization_code') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code grant type is supported'
    });
  }

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters'
    });
  }

  // Verify the stateless auth code — works on any instance, no shared state required
  const authCode = verifyPayload<{
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    expires_at: number;
  }>(code);

  if (!authCode) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code'
    });
  }

  if (authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code mismatch'
    });
  }

  if (!verifyPKCE(codeVerifier, authCode.code_challenge, authCode.code_challenge_method)) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid code verifier'
    });
  }

  const expiresIn = 86400; // 24 hours
  const accessToken = signPayload({
    client_id: clientId,
    expires_at: Date.now() + (expiresIn * 1000)
  });

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: accessToken
  });
});

app.get('/', (req, res) => {
  // Streamable HTTP session GET (SSE) uses mcp-session-id; bare GET stays a health check
  if (req.headers['mcp-session-id']) {
    return handleSessionRequest(req, res);
  }
  res.status(200).json({
    status: "healthy",
    service: "Tally MCP Server",
    message: "Tally MCP Server is running on Google Cloud Run",
    version: "8.2",
    endpoints: {
      metadata: "/.well-known/oauth-protected-resource",
      mcp: "/mcp",
      mcp_root: "/",
      authorize: "/authorize"
    }
  });
});

// Start MCP Server listener
app.listen(mcpPort, '0.0.0.0', () => console.log(`MCP Server started on port ${mcpPort}`));
