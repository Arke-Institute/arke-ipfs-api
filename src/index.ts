import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types/env';
import type { HonoEnv } from './types/hono';
import { validateEnv, getIPFSURL, getBackendURL, getArkePI } from './config';
import { IPFSService } from './services/ipfs';
import { TipService } from './services/tip';
import { createEntity, getEntity } from './services/eidos-ops';
import { errorToResponse, ValidationError } from './utils/errors';
import { Network, NETWORK_HEADER } from './types/network';

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
import { updateRelationsHandler, updateHierarchyHandler } from './handlers/relations';
import { mergeEntityHandler, unmergeEntityHandler } from './handlers/merge';
import { resolveHandler } from './handlers/resolve';
import { downloadHandler, dagDownloadHandler } from './handlers/download';
import { migrateEntityHandler, migrateBatchHandler } from './handlers/migrate';

const app = new Hono<HonoEnv>();

// CORS middleware (optional, configure as needed)
app.use('/*', cors());

// Initialize services middleware
app.use('*', async (c, next) => {
  const env = c.env;

  try {
    // Validate environment
    validateEnv(env);

    // Parse network header (default to 'main')
    const networkHeader = c.req.header(NETWORK_HEADER);
    let network: Network = 'main';

    if (networkHeader) {
      if (networkHeader !== 'main' && networkHeader !== 'test') {
        throw new ValidationError(
          `Invalid ${NETWORK_HEADER} header: must be 'main' or 'test'`,
          { received: networkHeader }
        );
      }
      network = networkHeader as Network;
    }

    c.set('network', network);

    // Initialize IPFS service
    const ipfsURL = getIPFSURL(env);
    const ipfs = new IPFSService(ipfsURL);
    c.set('ipfs', ipfs);

    // Initialize Tip service (network-aware)
    const tipService = new TipService(ipfs, network);
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

// GET /dag/:cid - Download DAG node (properties, relationships, etc.)
app.get('/dag/:cid', dagDownloadHandler);

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

// POST /entities/:sourceId/merge - Merge source into target
app.post('/entities/:sourceId/merge', mergeEntityHandler);

// POST /entities/:sourceId/unmerge - Unmerge (restore) source from target
app.post('/entities/:sourceId/unmerge', unmergeEntityHandler);

// POST /hierarchy - Update parent-child hierarchy relationships
app.post('/hierarchy', updateHierarchyHandler);

// POST /relations - DEPRECATED: Use /hierarchy instead (kept for backward compatibility)
app.post('/relations', updateRelationsHandler);

// GET /resolve/:pi
app.get('/resolve/:pi', resolveHandler);

// POST /migrate/batch - Migrate multiple entities (must be before /:pi route)
app.post('/migrate/batch', migrateBatchHandler);

// POST /migrate/:pi - Migrate entity from old schema to arke/eidos@v1
app.post('/migrate/:pi', migrateEntityHandler);

// POST /arke/init - Initialize Arke origin block if it doesn't exist
// Note: Arke origin block always uses main network (ARKE_PI starts with '00', not 'II')
app.post('/arke/init', async (c) => {
  const ARKE_PI = getArkePI(c.env);
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
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
    // ARKE_PI is a special fixed PI that belongs to main network
    const response = await createEntity(ipfs, tipSvc, {
      id: ARKE_PI,
      type: 'PI',
      components: { metadata: metadataCid },
      note: 'Genesis entity - root of the archive tree',
    }, network);

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
