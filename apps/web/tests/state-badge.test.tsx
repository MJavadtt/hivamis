import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STATE_LABELS, WORKFLOWS } from '@hiva/contracts';
import { StateBadge } from '../src/components/ui';

/**
 * The table's completeness is asserted in the API suite, where the contracts package is shared.
 * What matters here is the rendering contract: an unknown value must still be legible rather
 * than disappearing, because the fallback is what a user sees the day a new state is added.
 */
describe('StateBadge', () => {
  it('renders the Persian label for a declared state', () => {
    render(<StateBadge state="PENDING_AUTHORIZATION" />);
    expect(screen.getByText(STATE_LABELS.PENDING_AUTHORIZATION!.fa)).toBeDefined();
  });

  it('falls back to the raw value for an undeclared one', () => {
    render(<StateBadge state="A_STATE_NOBODY_DECLARED" />);
    expect(screen.getByText('A_STATE_NOBODY_DECLARED')).toBeDefined();
  });

  it('renders every state of every workflow without throwing', () => {
    for (const [entity, def] of Object.entries(WORKFLOWS)) {
      for (const state of def.states) {
        const { unmount } = render(<StateBadge state={state} />);
        expect(screen.getByText(STATE_LABELS[state]!.fa), `${entity}.${state}`).toBeDefined();
        unmount();
      }
    }
  });
});
