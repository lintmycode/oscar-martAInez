import { CONFIG } from '../config.js';

/**
 * Track OpenAI token usage and enforce budget limits
 */
export class TokenTracker {
  constructor() {
    this.stages = new Map();
    this.totalInput = 0;
    this.totalOutput = 0;
  }

  /**
   * Add usage from an OpenAI response
   */
  add(stageName, usage) {
    if (!usage) return;

    const { prompt_tokens, completion_tokens } = usage;

    if (!this.stages.has(stageName)) {
      this.stages.set(stageName, { input: 0, output: 0, calls: 0 });
    }

    const stage = this.stages.get(stageName);
    stage.input += prompt_tokens || 0;
    stage.output += completion_tokens || 0;
    stage.calls += 1;

    this.totalInput += prompt_tokens || 0;
    this.totalOutput += completion_tokens || 0;

    this.checkBudget();
  }

  /**
   * Check if budget exceeded and throw error
   */
  checkBudget() {
    const total = this.totalInput + this.totalOutput;

    if (total > CONFIG.budget.maxTokensPerRun) {
      this.printReport();
      throw new Error(
        `\n❌ BUDGET EXCEEDED: ${total.toLocaleString()} tokens used, ` +
        `limit is ${CONFIG.budget.maxTokensPerRun.toLocaleString()}\n` +
        `Processing aborted to prevent unexpected costs.`
      );
    }

    if (total > CONFIG.budget.warningThreshold) {
      const percent = Math.round((total / CONFIG.budget.maxTokensPerRun) * 100);
      console.log(
        `\n⚠️  Warning: ${percent}% of token budget used ` +
        `(${total.toLocaleString()}/${CONFIG.budget.maxTokensPerRun.toLocaleString()})\n`
      );
    }
  }

  /**
   * Calculate cost in USD
   */
  calculateCost() {
    const model = CONFIG.openai.model;
    const pricing = CONFIG.pricing[model];

    if (!pricing) {
      return { inputCost: 0, outputCost: 0, total: 0 };
    }

    const inputCost = (this.totalInput / 1_000_000) * pricing.input;
    const outputCost = (this.totalOutput / 1_000_000) * pricing.output;

    return {
      inputCost,
      outputCost,
      total: inputCost + outputCost,
    };
  }

  /**
   * Print detailed cost report
   */
  printReport() {
    console.log('\n' + '='.repeat(60));
    console.log('OPENAI TOKEN USAGE REPORT');
    console.log('='.repeat(60));

    // Per-stage breakdown
    console.log('\nBy stage:');
    for (const [stage, usage] of this.stages.entries()) {
      console.log(
        `  ${stage.padEnd(25)} ${usage.calls.toString().padStart(3)} calls  ` +
        `${usage.input.toLocaleString().padStart(8)} in  ` +
        `${usage.output.toLocaleString().padStart(8)} out`
      );
    }

    // Totals
    const total = this.totalInput + this.totalOutput;
    console.log('\nTotals:');
    console.log(`  Input tokens:  ${this.totalInput.toLocaleString()}`);
    console.log(`  Output tokens: ${this.totalOutput.toLocaleString()}`);
    console.log(`  Total tokens:  ${total.toLocaleString()}`);

    // Cost
    const cost = this.calculateCost();
    console.log('\nEstimated cost (USD):');
    console.log(`  Input:  $${cost.inputCost.toFixed(4)}`);
    console.log(`  Output: $${cost.outputCost.toFixed(4)}`);
    console.log(`  Total:  $${cost.total.toFixed(4)}`);

    // Budget status
    const percent = Math.round((total / CONFIG.budget.maxTokensPerRun) * 100);
    console.log(`\nBudget: ${percent}% used (${total.toLocaleString()}/${CONFIG.budget.maxTokensPerRun.toLocaleString()})`);

    console.log('='.repeat(60) + '\n');
  }
}
