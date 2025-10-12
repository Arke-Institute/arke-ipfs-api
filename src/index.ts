import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types/env';
import { validateEnv, getIPFSURL, getBackendURL, getArkePI } from './config';
import { IPFSService } from './services/ipfs';
import { TipService } from './services/tip';
import { createEntity, getEntity } from './services/entity-ops';
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

// Define context variables type
type Variables = {
  ipfs: IPFSService;
  tipService: TipService;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

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

// POST /arke/init - Initialize Arke origin block if it doesn't exist
app.post('/arke/init', async (c) => {
  const ARKE_PI = getArkePI(c.env);
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const backendURL = getBackendURL(c.env);

  try {
    // Check if Arke block already exists
    const exists = await tipSvc.tipExists(ARKE_PI);
    if (exists) {
      const existing = await getEntity(ipfs, tipSvc, ARKE_PI);
      return c.json({
        message: 'Arke origin block already exists',
        ...existing,
      });
    }

    // Upload Arke metadata
    const arkeMetadata = {
      name: 'Arke',
      type: 'root',
      description: 'Origin block of the Arke Institute archive tree. Contains all institutional collections.',
      note: 'Arke (ἀρχή) - Ancient Greek for \'origin\' or \'beginning\'',
    };
    const metadataBlob = new Blob([JSON.stringify(arkeMetadata, null, 2)]);
    const formData = new FormData();
    formData.append('file', metadataBlob, 'arke-metadata.json');
    const uploadResults = await ipfs.add(formData);
    const metadataCid = uploadResults[0].Hash;

    // Create entity using service layer
    const response = await createEntity(ipfs, tipSvc, backendURL, {
      pi: ARKE_PI,
      components: { metadata: metadataCid },
      note: 'Genesis entity - root of the archive tree',
    });

    return c.json({
      message: 'Arke origin block initialized',
      metadata_cid: metadataCid,
      ...response,
    }, 201);
  } catch (error) {
    return errorToResponse(error);
  }
});

// GET /arke - Convenience endpoint for the Arke origin block
app.get('/arke', async (c) => {
  const ARKE_PI = getArkePI(c.env);
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  try {
    const response = await getEntity(ipfs, tipSvc, ARKE_PI);
    return c.json(response);
  } catch (error) {
    return errorToResponse(error);
  }
});

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
