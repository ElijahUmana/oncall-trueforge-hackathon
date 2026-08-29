import { describe, expect, it } from 'vitest';
import { buildAlertMessage } from '../src/alert';

describe('buildAlertMessage', () => {
  it('identifies the requested incident and safety boundary', () => {
    const message = buildAlertMessage('INC-9000');

    expect(message).toContain('INC-9000');
    expect(message).toContain('Retrieve current incident data');
    expect(message).toContain('four runbook workers in parallel');
    expect(message).toContain('without the required human approval');
  });

  it('rejects malformed incident identifiers before creating runtime work', () => {
    expect(() => buildAlertMessage('INC-NOT-FOUND')).toThrow(
      'Incident ID must match INC-<digits>; received INC-NOT-FOUND',
    );
  });
});
