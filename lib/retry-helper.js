/**
 * Retry helper with exponential backoff for OpenAI rate limits
 */
export class RetryHelper {
  /**
   * Retry an async function with exponential backoff
   *
   * @param {Function} fn - Async function to retry
   * @param {Object} options - Retry options
   * @param {number} options.maxRetries - Maximum number of retries (default: 5)
   * @param {number} options.initialDelay - Initial delay in ms (default: 1000)
   * @param {number} options.maxDelay - Maximum delay in ms (default: 60000)
   * @param {number} options.backoffMultiplier - Backoff multiplier (default: 2)
   */
  static async retry(fn, options = {}) {
    const {
      maxRetries = 5,
      initialDelay = 1000,
      maxDelay = 60000,
      backoffMultiplier = 2,
    } = options;

    let lastError;
    let delay = initialDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Check if it's a rate limit error
        const isRateLimit = error.status === 429 ||
                           error.message?.includes('Rate limit') ||
                           error.message?.includes('429');

        if (!isRateLimit) {
          // Not a rate limit error, don't retry
          throw error;
        }

        if (attempt === maxRetries) {
          // Max retries reached
          throw new Error(
            `Rate limit retry failed after ${maxRetries} attempts: ${error.message}`
          );
        }

        // Extract wait time from error message if available
        // e.g., "Please try again in 293ms"
        const waitMatch = error.message?.match(/try again in (\d+)ms/);
        if (waitMatch) {
          const suggestedWait = parseInt(waitMatch[1]);
          delay = Math.max(suggestedWait + 100, delay); // Add 100ms buffer
        }

        // Cap at maxDelay
        delay = Math.min(delay, maxDelay);

        console.log(`  ⏳ Rate limit hit, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);

        await this.sleep(delay);

        // Exponential backoff
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      }
    }

    throw lastError;
  }

  /**
   * Sleep for specified milliseconds
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Add a delay between requests to avoid rate limits
   * Call this between batches of API calls
   */
  static async throttle(ms = 1000) {
    await this.sleep(ms);
  }
}
