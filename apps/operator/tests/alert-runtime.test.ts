import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  createTurn: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('@truefoundry/trueforge-sdk', () => ({
  TrueForge: class {
    sessions = {
      create: sdk.create,
      createTurn: sdk.createTurn,
      delete: sdk.deleteSession,
    };
  },
}));

import { triggerAlert } from '../src/alert';

const options = {
  baseUrl: 'http://127.0.0.1:8790',
  agentName: 'oncall-incident-responder',
  incidentId: 'INC-4821',
};

describe('triggerAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.create.mockResolvedValue({ data: { id: 'session-1' } });
    sdk.createTurn.mockResolvedValue({ data: { id: 'turn-1' } });
    sdk.deleteSession.mockResolvedValue(undefined);
  });

  it('creates a session and starts a background turn', async () => {
    await expect(triggerAlert(options)).resolves.toBe('session-1');

    expect(sdk.create).toHaveBeenCalledWith({
      agent: { name: 'oncall-incident-responder' },
    });
    expect(sdk.createTurn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ previousTurnId: 'auto' }),
    );
    expect(sdk.deleteSession).not.toHaveBeenCalled();
  });

  it('removes the empty session when turn creation fails', async () => {
    const turnError = new Error('turn failed');
    sdk.createTurn.mockRejectedValue(turnError);

    await expect(triggerAlert(options)).rejects.toBe(turnError);
    expect(sdk.deleteSession).toHaveBeenCalledWith('session-1');
  });

  it('surfaces both turn and cleanup failures', async () => {
    const turnError = new Error('turn failed');
    const cleanupError = new Error('cleanup failed');
    sdk.createTurn.mockRejectedValue(turnError);
    sdk.deleteSession.mockRejectedValue(cleanupError);

    await expect(triggerAlert(options)).rejects.toMatchObject({
      message:
        'Failed to start incident INC-4821 and remove empty session session-1',
      errors: [turnError, cleanupError],
    });
  });

  it('rejects malformed IDs before creating a session', async () => {
    await expect(
      triggerAlert({ ...options, incidentId: 'INC-NOT-FOUND' }),
    ).rejects.toThrow('Incident ID must match INC-<digits>');
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
