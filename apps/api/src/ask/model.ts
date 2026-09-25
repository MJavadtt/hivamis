/**
 * The language-model fallback for natural-language reporting (roadmap #27) — an adapter.
 *
 * Used only when the rules find no metric in a question. The model is shown the question and the
 * catalogue (keys, names, definitions) and nothing else — no record, no number — and it may only
 * answer by filling the plan tool: a metric key from the list, unit codes, names and ISO dates.
 * `ask()` validates that plan and resolves every name itself, under the asker's permissions, so a
 * model mistake can at worst produce a wrongly-understood question that the answer states plainly
 * («برداشت زیر را بررسی کنید»), never a number the asker may not see.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DEPARTMENT_CODES, WORKFLOWS } from '@hiva/contracts';
import { aiEnabled, env } from '../env.js';
import { DIMS } from './catalog.js';
import type { Planner } from './answer.js';

export function modelPlanner(): Planner | null {
  if (!aiEnabled) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return async (question, metrics, now) => {
    const message = await client.messages.create({
      model: env.AI_MODEL,
      max_tokens: 400,
      system: [
        'You map one Persian question about an advertising agency\'s operational numbers to a plan over a fixed list of metrics.',
        'Answer only with the plan tool. If no metric in the list fits, use metric "NONE" — never stretch a metric to fit.',
        `Today is ${now.toISOString().slice(0, 10)} (Gregorian). Dates are Gregorian ISO dates; "to" is exclusive.`,
        'Give names of clients, projects and people exactly as written in the question; do not invent ids.',
      ].join('\n'),
      tools: [{
        name: 'plan',
        description: 'The plan for the question.',
        input_schema: {
          type: 'object',
          properties: {
            metric: { type: 'string', enum: [...metrics.map((m) => m.key), 'NONE'] },
            units: { type: 'array', items: { type: 'string', enum: [...DEPARTMENT_CODES] } },
            companyName: { type: 'string' },
            projectCode: { type: 'string' },
            personName: { type: 'string' },
            entity: { type: 'string', enum: Object.keys(WORKFLOWS) },
            from: { type: 'string', description: 'YYYY-MM-DD' },
            to: { type: 'string', description: 'YYYY-MM-DD, exclusive' },
            groupBy: { type: 'string', enum: DIMS },
            compare: { type: 'boolean' },
          },
          required: ['metric'],
        },
      }],
      tool_choice: { type: 'tool', name: 'plan' },
      messages: [{
        role: 'user',
        content: `پرسش: ${question}\n\nشاخص‌ها:\n${metrics.map((m) => `- ${m.key}: ${m.labelFa} — ${m.definitionFa} (تفکیک: ${m.dims.join(', ') || '—'})`).join('\n')}`,
      }],
    });
    const block = message.content.find((b) => b.type === 'tool_use');
    return block && block.type === 'tool_use' ? block.input : null;
  };
}
