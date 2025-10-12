import { z } from 'zod';

/**
 * IPLD link format: { "/": "<cid>" }
 * Used for dag-json encoding to create proper DAG links
 */
export interface IPLDLink {
  '/': string;
}

/**
 * Convert CID string to IPLD link object
 */
export function link(cid: string): IPLDLink {
  return { '/': cid };
}

/**
 * Manifest schema version 1
 * Stored as dag-json in IPFS with pin=true
 */
export interface ManifestV1 {
  schema: 'arke/manifest@v1';
  pi: string; // ULID
  ver: number; // version number (starts at 1)
  ts: string; // ISO 8601 timestamp
  prev: IPLDLink | null; // link to previous version (null for v1)
  components: {
    [label: string]: IPLDLink; // e.g., { metadata: { "/": "bafy..." }, image: { "/": "bafy..." } }
  };
  children_pi?: string[]; // optional array of child PI ULIDs
  parent_pi?: string; // optional parent PI ULID (for bidirectional traversal)
  note?: string; // optional change note
}

/**
 * Snapshot index schema (for DR/CAR export)
 * Contains current tips for all entities
 */
export interface SnapshotIndex {
  schema: 'arke/snapshot-index@v1';
  seq: number; // monotonically increasing
  ts: string; // ISO 8601
  prev: IPLDLink | null; // link to previous snapshot
  entries: Array<{
    pi: string;
    ver: number;
    tip: IPLDLink;
  }>;
}

// Zod schemas for runtime validation

export const IPLDLinkSchema = z.object({
  '/': z.string().min(1),
});

export const ManifestV1Schema = z.object({
  schema: z.literal('arke/manifest@v1'),
  pi: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Invalid ULID'),
  ver: z.number().int().positive(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema.nullable(),
  components: z.record(IPLDLinkSchema),
  children_pi: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).optional(),
  parent_pi: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  note: z.string().optional(),
});

export const SnapshotIndexSchema = z.object({
  schema: z.literal('arke/snapshot-index@v1'),
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema.nullable(),
  entries: z.array(
    z.object({
      pi: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      ver: z.number().int().positive(),
      tip: IPLDLinkSchema,
    })
  ),
});

// API request/response types

export interface CreateEntityRequest {
  pi?: string; // optional; server generates if not provided
  components: Record<string, string>; // label -> CID (will be converted to IPLDLink)
  children_pi?: string[];
  parent_pi?: string; // optional; if provided, server auto-updates parent's children_pi
  note?: string;
}

export interface CreateEntityResponse {
  pi: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

export interface AppendVersionRequest {
  expect_tip: string; // CAS guard
  components?: Record<string, string>; // partial updates ok
  children_pi_add?: string[];
  children_pi_remove?: string[];
  note?: string;
}

export interface AppendVersionResponse {
  pi: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

export interface GetEntityResponse {
  pi: string;
  ver: number;
  ts: string;
  manifest_cid: string;
  prev_cid?: string | null;
  components: Record<string, string>; // label -> CID
  children_pi?: string[];
  parent_pi?: string;
  note?: string;
}

export interface VersionHistoryItem {
  ver: number;
  cid: string;
  ts: string;
  note?: string;
}

export interface ListVersionsResponse {
  items: VersionHistoryItem[];
  next_cursor: string | null;
}

export interface UpdateRelationsRequest {
  parent_pi: string;
  expect_tip: string; // CAS guard
  add_children?: string[];
  remove_children?: string[];
  note?: string;
}

export interface ResolveResponse {
  pi: string;
  tip: string;
}

export interface UploadResponse {
  name: string;
  cid: string;
  size: number;
}

// Validation schemas for API requests

export const CreateEntityRequestSchema = z.object({
  pi: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  components: z.record(z.string()),
  children_pi: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).optional(),
  parent_pi: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  note: z.string().optional(),
});

export const AppendVersionRequestSchema = z.object({
  expect_tip: z.string().min(1),
  components: z.record(z.string()).optional(),
  children_pi_add: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).optional(),
  children_pi_remove: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).optional(),
  note: z.string().optional(),
});

export const UpdateRelationsRequestSchema = z.object({
  parent_pi: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  expect_tip: z.string().min(1),
  add_children: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).optional(),
  remove_children: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).optional(),
  note: z.string().optional(),
});
