import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemoteShellProfileModule from './remote-shell-profile';
import { SshClientProxy } from './ssh-client-proxy';

const mocks = vi.hoisted(() => ({
  captureRemoteShellProfile: vi.fn(),
}));

vi.mock('./remote-shell-profile', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof RemoteShellProfileModule;
  return {
    ...actual,
    captureRemoteShellProfile: mocks.captureRemoteShellProfile,
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function createMockClient(sftpImpl?: (cb: (err: Error | null, sftp: any) => void) => void): any {
  return {
    sftp:
      sftpImpl ??
      ((cb: (err: Error | null, sftp: any) => void) => {
        const sftp = new EventEmitter();
        cb(null, sftp);
      }),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('SshClientProxy remote shell profile', () => {
  beforeEach(() => {
    mocks.captureRemoteShellProfile.mockReset();
  });

  it('returns a rejected promise when the SSH connection is unavailable', async () => {
    const proxy = new SshClientProxy();

    await expect(proxy.getRemoteShellProfile()).rejects.toThrow('SSH connection is not available');
  });

  it('captures and caches the remote shell profile behind the proxy API', async () => {
    const client = {};
    const profile = {
      shell: '/bin/zsh',
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
    };
    mocks.captureRemoteShellProfile.mockResolvedValue(profile);
    const proxy = new SshClientProxy();
    proxy.update(client as never);

    await expect(proxy.getRemoteShellProfile()).resolves.toBe(profile);
    await expect(proxy.getRemoteShellProfile()).resolves.toBe(profile);

    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(1);
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledWith(client);
  });

  it('does not cache an in-flight shell profile after invalidation', async () => {
    let resolveFirst!: (profile: { shell: string; env: Record<string, string> }) => void;
    const firstCapture = new Promise<{ shell: string; env: Record<string, string> }>((resolve) => {
      resolveFirst = resolve;
    });
    const firstClient = {};
    const secondClient = {};
    mocks.captureRemoteShellProfile
      .mockReturnValueOnce(firstCapture)
      .mockResolvedValueOnce({ shell: '/bin/bash', env: { PATH: '/second' } });
    const proxy = new SshClientProxy();

    proxy.update(firstClient as never);
    const staleCapture = proxy.getRemoteShellProfile();
    proxy.invalidate();
    proxy.update(secondClient as never);
    resolveFirst({ shell: '/bin/zsh', env: { PATH: '/first' } });
    await staleCapture;

    await expect(proxy.getRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/bash',
      env: { PATH: '/second' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(2);
    expect(mocks.captureRemoteShellProfile).toHaveBeenNthCalledWith(2, secondClient);
  });

  it('clears cached shell profile on invalidate', async () => {
    const firstClient = {};
    const secondClient = {};
    mocks.captureRemoteShellProfile
      .mockResolvedValueOnce({ shell: '/bin/zsh', env: { PATH: '/first' } })
      .mockResolvedValueOnce({ shell: '/bin/bash', env: { PATH: '/second' } });
    const proxy = new SshClientProxy();

    proxy.update(firstClient as never);
    await proxy.getRemoteShellProfile();
    proxy.invalidate();
    proxy.update(secondClient as never);
    const profile = await proxy.getRemoteShellProfile();

    expect(profile).toEqual({ shell: '/bin/bash', env: { PATH: '/second' } });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(2);
  });

  it('reports channel error and recovery via healthReporter', () => {
    const reporter = {
      reportChannelError: vi.fn(),
      reportChannelRecovered: vi.fn(),
    };
    const proxy = new SshClientProxy(reporter, 'ssh-1');

    // Simulate an SFTP error
    const client = createMockClient((cb) => {
      cb(new Error('SFTP subsystem request failed'), new EventEmitter());
    });
    proxy.update(client);

    const cb = vi.fn();
    proxy.sftp(cb);

    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', expect.any(Error));

    // Now simulate success
    const client2 = createMockClient();
    proxy.update(client2);
    const cb2 = vi.fn();
    proxy.sftp(cb2);

    expect(reporter.reportChannelRecovered).toHaveBeenCalledWith('ssh-1');
  });
});

describe('SshClientProxy SFTP channel caching', () => {
  it('reuses an open SFTP channel for the same SSH connection', () => {
    const proxy = new SshClientProxy();
    const client = createMockClient();
    proxy.update(client);

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    proxy.sftp(cb1);
    proxy.sftp(cb2);

    // Both callbacks should have been invoked with the same sftp instance
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb1.mock.calls[0]![0]).toBeUndefined();
    const sftp1 = cb1.mock.calls[0]![1];

    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2.mock.calls[0]![0]).toBeUndefined();
    const sftp2 = cb2.mock.calls[0]![1];

    expect(sftp1).toBe(sftp2);
  });

  it('opens a new SFTP channel after the cached channel closes', () => {
    const proxy = new SshClientProxy();
    let sftpInstance: EventEmitter | undefined;
    const client = createMockClient((cb) => {
      sftpInstance = new EventEmitter();
      cb(null, sftpInstance!);
    });
    proxy.update(client);

    const cb1 = vi.fn();
    proxy.sftp(cb1);
    expect(cb1).toHaveBeenCalledTimes(1);
    const firstSftp = cb1.mock.calls[0]![1];

    // Emit close on the sftp — should clear the cache
    sftpInstance!.emit('close');

    const cb2 = vi.fn();
    proxy.sftp(cb2);
    expect(cb2).toHaveBeenCalledTimes(1);
    // A new SFTP channel should have been opened (different instance)
    expect(cb2.mock.calls[0]![1]).not.toBe(firstSftp);
  });

  it('drains queued callbacks if the connection is invalidated while SFTP is opening', () => {
    const proxy = new SshClientProxy();
    let resolveSftp!: (sftp: EventEmitter) => void;
    const client = createMockClient((cb) => {
      resolveSftp = (sftp: EventEmitter) => cb(null, sftp);
    });
    proxy.update(client);

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    proxy.sftp(cb1);
    proxy.sftp(cb2);

    // Neither should have fired yet
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();

    // Invalidate while SFTP is still loading
    proxy.invalidate();

    // Now resolve the SFTP
    resolveSftp(new EventEmitter());

    // Both callbacks should still be drained
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb1.mock.calls[0]![0]).toBeUndefined();
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2.mock.calls[0]![0]).toBeUndefined();
  });

  it('drains queued callbacks without caching stale SFTP after the client changes', () => {
    const proxy = new SshClientProxy();
    let resolveFirstSftp!: (sftp: EventEmitter) => void;
    const firstClient = createMockClient((cb) => {
      resolveFirstSftp = (sftp: EventEmitter) => cb(null, sftp);
    });
    proxy.update(firstClient);

    const cb1 = vi.fn();
    proxy.sftp(cb1);

    // Switch to a new client before the first SFTP resolves
    const secondClient = createMockClient();
    proxy.update(secondClient);

    // Resolve the first SFTP (stale)
    resolveFirstSftp(new EventEmitter());

    // cb1 should still be drained
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb1.mock.calls[0]![0]).toBeUndefined();
    // The stale SFTP should NOT be cached — next call opens fresh
    const cb2 = vi.fn();
    proxy.sftp(cb2);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2.mock.calls[0]![1]).not.toBe(cb1.mock.calls[0]![1]);
  });

  it('does not report stale SFTP opens as current channel recovery', () => {
    const reporter = {
      reportChannelError: vi.fn(),
      reportChannelRecovered: vi.fn(),
    };
    const proxy = new SshClientProxy(reporter, 'ssh-1');

    let resolveFirstSftp!: (sftp: EventEmitter) => void;
    const firstClient = createMockClient((cb) => {
      resolveFirstSftp = (sftp: EventEmitter) => cb(null, sftp);
    });
    proxy.update(firstClient);

    const cb1 = vi.fn();
    proxy.sftp(cb1);

    // Switch to a new client before the first SFTP resolves
    const secondClient = createMockClient();
    proxy.update(secondClient);

    // Resolve the stale first SFTP
    resolveFirstSftp(new EventEmitter());

    // The stale open should NOT trigger reportChannelRecovered for the current client
    expect(reporter.reportChannelRecovered).not.toHaveBeenCalled();

    // But a new sftp call on the current client should trigger recovery
    const cb2 = vi.fn();
    proxy.sftp(cb2);
    expect(reporter.reportChannelRecovered).toHaveBeenCalledWith('ssh-1');
  });
});

describe('SshClientProxy integration: call-site wiring', () => {
  it('proxy.sftp() is used instead of proxy.client.sftp() for channel reuse', () => {
    // Verify that the proxy's sftp() method reuses channels, which is the
    // contract that controller.listFiles and SshFileSystem.getSftp() rely on.
    const sftpCallCount = vi.fn();
    const client = createMockClient((cb) => {
      sftpCallCount();
      cb(null, new EventEmitter());
    });
    const proxy = new SshClientProxy();
    proxy.update(client);

    // Call proxy.sftp() multiple times
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    proxy.sftp(cb1);
    proxy.sftp(cb2);
    proxy.sftp(cb3);

    // client.sftp should have been called only once (channel reuse)
    expect(sftpCallCount).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  it('client.sftp() is called once for concurrent proxy.sftp() calls (coalescing)', () => {
    const sftpCallCount = vi.fn();
    let resolveSftp!: (sftp: EventEmitter) => void;
    const client = createMockClient((cb) => {
      sftpCallCount();
      resolveSftp = (sftp: EventEmitter) => cb(null, sftp);
    });
    const proxy = new SshClientProxy();
    proxy.update(client);

    // Issue multiple concurrent sftp() calls before the first resolves
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    proxy.sftp(cb1);
    proxy.sftp(cb2);
    proxy.sftp(cb3);

    // None should have fired yet (async)
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    expect(cb3).not.toHaveBeenCalled();

    // client.sftp was called only once despite 3 proxy.sftp() calls
    expect(sftpCallCount).toHaveBeenCalledTimes(1);

    // Now resolve
    resolveSftp(new EventEmitter());

    // All callbacks should now be called
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  it('after SFTP close event, subsequent proxy.sftp() opens a fresh channel', () => {
    const sftpCallCount = vi.fn();
    let sftpInstance: EventEmitter | undefined;
    const client = createMockClient((cb) => {
      sftpCallCount();
      sftpInstance = new EventEmitter();
      cb(null, sftpInstance!);
    });
    const proxy = new SshClientProxy();
    proxy.update(client);

    // First call
    const cb1 = vi.fn();
    proxy.sftp(cb1);
    expect(sftpCallCount).toHaveBeenCalledTimes(1);

    // Emit close — should invalidate cache
    sftpInstance!.emit('close');

    // Second call should open a new channel
    const cb2 = vi.fn();
    proxy.sftp(cb2);
    expect(sftpCallCount).toHaveBeenCalledTimes(2);
  });

  it('passes health reporter and connection ID through to constructor', () => {
    const reporter = {
      reportChannelError: vi.fn(),
      reportChannelRecovered: vi.fn(),
    };
    const proxy = new SshClientProxy(reporter, 'conn-42');

    // Simulate an error on the underlying client.sftp
    const client = createMockClient((cb) => {
      cb(new Error('SFTP subsystem failed'), new EventEmitter());
    });
    proxy.update(client);

    const cb = vi.fn();
    proxy.sftp(cb);

    expect(reporter.reportChannelError).toHaveBeenCalledWith('conn-42', expect.any(Error));
  });
});
