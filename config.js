// Configuration for OpenAI and cost control
export const CONFIG = {
  // OpenAI API settings
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: 'gpt-4o-mini', // Cheapest multimodal model
    maxTokensPerRequest: 2000, // Hard limit per request
  },

  // Cost control
  budget: {
    maxTokensPerRun: 500000, // Abort if exceeded
    warningThreshold: 450000, // Warn at 75%
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
  },

  // Invoice matching thresholds
  matching: {
    amountTolerance: 1.50, // EUR (allows for currency conversion fluctuations)
    dateProximityDays: 7,
    vendorSimilarityThreshold: 0.6, // 0-1 scale
    batchSize: 30, // Transactions per OpenAI request
  },

  // Local processing first
  useLocalPdfExtraction: true,
  useOcrOnlyWhenNeeded: true,
  cacheInvoices: true,

  // currency conversion
  usd2eur: 0.95
};
