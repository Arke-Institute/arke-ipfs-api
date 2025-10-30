/**
 * Process items in parallel batches
 *
 * Instead of Promise.all() which processes everything at once,
 * this processes items in smaller batches to avoid overwhelming
 * the system (especially important for Cloudflare Workers).
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items to process in parallel per batch
 * @param processor - Async function to process each item
 * @returns Array of results (same order as input)
 *
 * @example
 * const results = await processBatched(
 *   childrenPIs,
 *   10,
 *   async (childPI) => updateChild(childPI)
 * );
 */
export async function processBatched<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];

  // Process in batches
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processor(item))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Process items in parallel batches with error handling
 *
 * Similar to processBatched but uses Promise.allSettled so that
 * failures in one item don't block others.
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items to process in parallel per batch
 * @param processor - Async function to process each item
 * @returns Array of settled results
 */
export async function processBatchedSettled<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];

  // Process in batches
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(item => processor(item))
    );
    results.push(...batchResults);
  }

  return results;
}
