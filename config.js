// Configuration for OpenAI and cost control
export const CONFIG = {
  // OpenAI API settings
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: 'gpt-4o-mini', // Options: 'gpt-4o-mini', 'gpt-4o', 'o1-mini'
    maxTokensPerRequest: 2000, // Hard limit per request
    // Rate limits (free tier): 200k TPM, 500 RPM
    // Rate limits (tier 1): 2M TPM, 500 RPM
  },

  // Cost control
  budget: {
    maxTokensPerRun: 1000000, // Abort if exceeded
    warningThreshold: 950000, // Warn at 75%
  },

  // Pricing (USD per 1M tokens) - update from OpenAI pricing page
  pricing: {
    'gpt-4o-mini': {
      input: 0.150,
      output: 0.600,
    },
    'gpt-4o': {
      input: 2.50,
      output: 10.00,
    },
    'o1-mini': {
      input: 3.00,
      output: 12.00,
    },
  },

  // Invoice matching thresholds
  matching: {
    amountTolerance: 1.50, // EUR (allows for currency conversion fluctuations)
    dateProximityDays: 3,
    vendorSimilarityThreshold: 0.8, // 0-1 scale
    batchSize: 30, // Transactions per OpenAI request
  },

  // Local processing first
  useLocalPdfExtraction: true,
  useOcrOnlyWhenNeeded: true,
  cacheInvoices: true,

  // currency conversion
  // Static approximation, not live FX - was 0.95 but that no longer reflects
  // reality; recalibrated from 6 actual USD invoice vs EUR-charged-amount pairs
  // (DigitalOcean + OpenAI, Apr-Jun 2026), which clustered at 0.857-0.881.
  // Still drifts over time - a live FX rate lookup would be the real fix.
  usd2eur: 0.87,

  // company info
  company: {
    name: 'nitida',
  },
};
