import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types/env';
import { validateEnv, getIPFSURL } from './config';
import { IPFSService } from './services/ipfs';
import { TipService } from './services/tip';
import { errorToResponse } from './utils/errors';

// Handlers
import { uploadHandler } from './handlers/upload';
import {
  createEntityHandler,
  getEntityHandler,
  listEntitiesHandler,
} from './handlers/entities';
import {
  appendVersionHandler,
  listVersionsHandler,
  getVersionHandler,
} from './handlers/versions';
import { updateRelationsHandler } from './handlers/relations';
import { resolveHandler } from './handlers/resolve';
import { downloadHandler } from './handlers/download';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware (optional, configure as needed)
app.use('/*', cors());

// Initialize services middleware
app.use('*', async (c, next) => {
  const env = c.env;

  try {
    // Validate environment
    validateEnv(env);

    // Initialize IPFS service
    const ipfsURL = getIPFSURL(env);
    const ipfs = new IPFSService(ipfsURL);
    c.set('ipfs', ipfs);

    // Initialize Tip service
    const tipService = new TipService(ipfs);
    c.set('tipService', tipService);

    await next();
  } catch (error) {
    return errorToResponse(error);
  }
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return errorToResponse(err);
});

// Health check
app.get('/', (c) => {
  return c.json({
    service: 'arke-ipfs-api',
    version: '0.1.0',
    status: 'ok',
  });
});

// Routes

// POST /upload
app.post('/upload', uploadHandler);

// GET /cat/:cid - Download file content
app.get('/cat/:cid', downloadHandler);

// GET /entities - List all entities (must come before /:pi route)
app.get('/entities', listEntitiesHandler);

// POST /entities
app.post('/entities', createEntityHandler);

// GET /entities/:pi
app.get('/entities/:pi', getEntityHandler);

// POST /entities/:pi/versions
app.post('/entities/:pi/versions', appendVersionHandler);

// GET /entities/:pi/versions
app.get('/entities/:pi/versions', listVersionsHandler);

// GET /entities/:pi/versions/:selector
app.get('/entities/:pi/versions/:selector', getVersionHandler);

// POST /relations
app.post('/relations', updateRelationsHandler);

// GET /resolve/:pi
app.get('/resolve/:pi', resolveHandler);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: 'NOT_FOUND',
      message: 'Route not found',
    },
    404
  );
});

export default app;
